import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../../../db";
import {
	abhashMemberMeta,
	abhashSsoGroupMapping,
	abhashTeam,
	abhashTeamMember,
	member,
	organization,
	organizationRole,
	user,
} from "../../../db/schema";
import { isFlagEnabled } from "../flags";
import { verifyScimBearer } from "./tokens";

const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const MEDIA_TYPES = ["application/json", "application/scim+json"];

type Team = typeof abhashTeam.$inferSelect;
type Ctx = {
	headers?: Headers;
	params?: Record<string, string>;
	query?: Record<string, unknown>;
	body?: unknown;
	json: (data: unknown) => unknown;
	setStatus: (status: number) => void;
};

const scimError = (status: number, detail: string) =>
	new APIError(
		status === 401
			? "UNAUTHORIZED"
			: status === 404
				? "NOT_FOUND"
				: "BAD_REQUEST",
		{
			schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
			status: String(status),
			detail,
		},
	);

const authenticate = async (ctx: Ctx) => {
	if (!(await isFlagEnabled("scim.enabled"))) throw scimError(404, "Not found");
	const connection = await verifyScimBearer(ctx.headers?.get("authorization"));
	if (!connection) throw scimError(401, "Invalid SCIM token");
	return connection;
};

const slugFor = (name: string) =>
	`scim-${name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40)}-${nanoid(6).toLowerCase()}`;

const resource = async (team: Team, baseURL: string) => {
	const members = await db
		.select({ id: user.id, email: user.email })
		.from(abhashTeamMember)
		.innerJoin(user, eq(user.id, abhashTeamMember.userId))
		.where(
			and(
				eq(abhashTeamMember.teamId, team.id),
				eq(abhashTeamMember.source, "scim"),
			),
		);
	return {
		schemas: [GROUP_SCHEMA],
		id: team.id,
		externalId: team.externalId ?? undefined,
		displayName: team.name,
		members: members.map((m) => ({
			value: m.id,
			display: m.email,
			$ref: `${baseURL}/scim/v2/Users/${m.id}`,
		})),
		meta: {
			resourceType: "Group",
			created: team.createdAt,
			lastModified: team.updatedAt ?? team.createdAt,
			location: `${baseURL}/scim/v2/Groups/${team.id}`,
		},
	};
};

const findTeam = async (organizationId: string, id: string | undefined) => {
	if (!id) throw scimError(404, "Group not found");
	const team = await db.query.abhashTeam.findFirst({
		where: and(
			eq(abhashTeam.id, id),
			eq(abhashTeam.organizationId, organizationId),
			eq(abhashTeam.source, "scim"),
		),
	});
	if (!team) throw scimError(404, "Group not found");
	return team;
};

/** Only people who are already members of the organization can be in its teams. */
const orgMembers = async (organizationId: string, userIds: string[]) => {
	if (userIds.length === 0) return [];
	const rows = await db.query.member.findMany({
		where: and(
			eq(member.organizationId, organizationId),
			inArray(member.userId, userIds),
		),
		columns: { userId: true },
	});
	return rows.map((r) => r.userId);
};

const memberIds = (value: unknown): string[] =>
	(Array.isArray(value) ? value : value ? [value] : [])
		.map((m) => (typeof m === "string" ? m : (m as { value?: unknown })?.value))
		.filter((v): v is string => typeof v === "string" && v.length > 0);

const setMembers = async (team: Team, userIds: string[]) => {
	const before = await db.query.abhashTeamMember.findMany({
		where: and(
			eq(abhashTeamMember.teamId, team.id),
			eq(abhashTeamMember.source, "scim"),
		),
	});
	const wanted = new Set(await orgMembers(team.organizationId, userIds));
	await db.transaction(async (tx) => {
		await tx
			.delete(abhashTeamMember)
			.where(
				and(
					eq(abhashTeamMember.teamId, team.id),
					eq(abhashTeamMember.source, "scim"),
				),
			);
		if (wanted.size) {
			await tx
				.insert(abhashTeamMember)
				.values(
					[...wanted].map((userId) => ({
						teamId: team.id,
						userId,
						source: "scim" as const,
					})),
				)
				.onConflictDoNothing();
		}
	});
	await syncScimRoles(team.organizationId, [
		...new Set([...before.map((b) => b.userId), ...wanted]),
	]);
};

/**
 * Organization roles from SCIM groups, using the group mappings that apply to
 * every provider. Owners and pinned roles are left alone; without a mapped
 * group a member falls back to the organization's default role.
 */
export const syncScimRoles = async (
	organizationId: string,
	userIds: string[],
) => {
	if (userIds.length === 0) return;
	const mappings = await db.query.abhashSsoGroupMapping.findMany({
		where: eq(abhashSsoGroupMapping.organizationId, organizationId),
	});
	const roleMappings = mappings.filter(
		(m) => m.providerId === null && m.orgRole,
	);
	if (roleMappings.length === 0) return;
	const org = await db.query.organization.findFirst({
		where: eq(organization.id, organizationId),
		columns: { defaultRole: true },
	});
	for (const userId of userIds) {
		const row = await db.query.member.findFirst({
			where: and(
				eq(member.organizationId, organizationId),
				eq(member.userId, userId),
			),
		});
		if (!row || row.role === "owner") continue;
		const meta = await db.query.abhashMemberMeta.findFirst({
			where: eq(abhashMemberMeta.memberId, row.id),
		});
		if (meta?.rolePinned) continue;
		const groups = (
			await db
				.select({ name: abhashTeam.name })
				.from(abhashTeamMember)
				.innerJoin(abhashTeam, eq(abhashTeam.id, abhashTeamMember.teamId))
				.where(
					and(
						eq(abhashTeamMember.userId, userId),
						eq(abhashTeamMember.source, "scim"),
						eq(abhashTeam.organizationId, organizationId),
					),
				)
		).map((g) => g.name.toLowerCase());
		const mapped = roleMappings
			.filter((m) => groups.includes(m.groupName.toLowerCase()))
			.sort((a, b) => b.priority - a.priority)[0]?.orgRole;
		let role = mapped ?? org?.defaultRole ?? "member";
		if (role === "owner") role = "member";
		if (role !== "admin" && role !== "member") {
			const custom = await db.query.organizationRole.findFirst({
				where: and(
					eq(organizationRole.organizationId, organizationId),
					eq(organizationRole.role, role),
				),
			});
			if (!custom) role = "member";
		}
		if (role !== row.role) {
			await db.update(member).set({ role }).where(eq(member.id, row.id));
			await db
				.insert(abhashMemberMeta)
				.values({ memberId: row.id, roleSource: "scim" })
				.onConflictDoUpdate({
					target: abhashMemberMeta.memberId,
					set: { roleSource: "scim" },
				});
		}
	}
};

const parseFilter = (filter: unknown) => {
	if (typeof filter !== "string") return null;
	const match = filter.match(
		/^\s*(displayName|externalId)\s+eq\s+"([^"]*)"\s*$/i,
	);
	return match
		? { field: match[1]?.toLowerCase(), value: match[2] ?? "" }
		: null;
};

const loose = z.object({}).passthrough();

type PatchOp = { op?: string; path?: string; value?: unknown };

const applyPatch = async (team: Team, operations: PatchOp[]) => {
	let current = (
		await db.query.abhashTeamMember.findMany({
			where: and(
				eq(abhashTeamMember.teamId, team.id),
				eq(abhashTeamMember.source, "scim"),
			),
		})
	).map((m) => m.userId);
	let membersChanged = false;
	const rename: Partial<Pick<Team, "name" | "externalId">> = {};

	for (const operation of operations) {
		const op = operation.op?.toLowerCase();
		const path = operation.path ?? "";
		const filtered = path.match(/^members\[value eq "([^"]+)"\]$/i);
		if (op === "add" && path.toLowerCase() === "members") {
			current = [...new Set([...current, ...memberIds(operation.value)])];
			membersChanged = true;
		} else if (op === "remove" && filtered) {
			current = current.filter((id) => id !== filtered[1]);
			membersChanged = true;
		} else if (op === "remove" && path.toLowerCase() === "members") {
			const gone = new Set(memberIds(operation.value));
			current = gone.size ? current.filter((id) => !gone.has(id)) : [];
			membersChanged = true;
		} else if (op === "replace" && path.toLowerCase() === "members") {
			current = memberIds(operation.value);
			membersChanged = true;
		} else if (op === "replace" && path.toLowerCase() === "displayname") {
			rename.name = String(operation.value);
		} else if (op === "replace" && !path && operation.value) {
			const value = operation.value as Record<string, unknown>;
			if (typeof value.displayName === "string")
				rename.name = value.displayName;
			if (typeof value.externalId === "string")
				rename.externalId = value.externalId;
			if ("members" in value) {
				current = memberIds(value.members);
				membersChanged = true;
			}
		} else {
			throw scimError(400, `Unsupported patch operation ${op} ${path}`);
		}
	}
	if (Object.keys(rename).length) {
		await db.update(abhashTeam).set(rename).where(eq(abhashTeam.id, team.id));
	}
	if (membersChanged) await setMembers(team, current);
};

const endpoint = <P extends string>(
	path: P,
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
) => ({
	path,
	options: {
		method,
		...(method === "GET" || method === "DELETE" ? {} : { body: loose }),
		metadata: { allowedMediaTypes: MEDIA_TYPES, isAction: false },
	},
});

/** SCIM Groups, provisioned as teams. The SCIM plugin only covers Users. */
export const abhashScimGroups = () => {
	const list = endpoint("/scim/v2/Groups", "GET");
	const create = endpoint("/scim/v2/Groups", "POST");
	const get = endpoint("/scim/v2/Groups/:groupId", "GET");
	const replace = endpoint("/scim/v2/Groups/:groupId", "PUT");
	const patch = endpoint("/scim/v2/Groups/:groupId", "PATCH");
	const remove = endpoint("/scim/v2/Groups/:groupId", "DELETE");

	return {
		id: "abhash-scim-groups",
		endpoints: {
			listScimGroups: createAuthEndpoint(
				list.path,
				list.options as never,
				async (ctx) => {
					const c = ctx as unknown as Ctx & { context: { baseURL: string } };
					const { organizationId } = await authenticate(c);
					const filter = parseFilter(c.query?.filter);
					const teams = await db.query.abhashTeam.findMany({
						where: and(
							eq(abhashTeam.organizationId, organizationId),
							eq(abhashTeam.source, "scim"),
							...(filter?.field === "displayname"
								? [eq(abhashTeam.name, filter.value)]
								: []),
							...(filter?.field === "externalid"
								? [eq(abhashTeam.externalId, filter.value)]
								: []),
						),
					});
					const resources = await Promise.all(
						teams.map((t) => resource(t, c.context.baseURL)),
					);
					return c.json({
						schemas: [LIST_SCHEMA],
						totalResults: resources.length,
						startIndex: 1,
						itemsPerPage: resources.length,
						Resources: resources,
					});
				},
			),

			createScimGroup: createAuthEndpoint(
				create.path,
				create.options as never,
				async (ctx) => {
					const c = ctx as unknown as Ctx & { context: { baseURL: string } };
					const { organizationId } = await authenticate(c);
					const body = c.body as {
						displayName?: string;
						externalId?: string;
						members?: unknown;
					};
					if (!body.displayName)
						throw scimError(400, "displayName is required");
					const existing = await db.query.abhashTeam.findFirst({
						where: and(
							eq(abhashTeam.organizationId, organizationId),
							eq(abhashTeam.source, "scim"),
							eq(abhashTeam.name, body.displayName),
						),
					});
					if (existing) {
						throw new APIError("CONFLICT", {
							schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
							status: "409",
							scimType: "uniqueness",
							detail: "A group with this displayName exists",
						});
					}
					const [team] = await db
						.insert(abhashTeam)
						.values({
							organizationId,
							name: body.displayName,
							slug: slugFor(body.displayName),
							source: "scim",
							externalId: body.externalId,
						})
						.returning();
					if (!team) throw scimError(400, "Could not create the group");
					await setMembers(team, memberIds(body.members));
					c.setStatus(201);
					return c.json(await resource(team, c.context.baseURL));
				},
			),

			getScimGroup: createAuthEndpoint(
				get.path,
				get.options as never,
				async (ctx) => {
					const c = ctx as unknown as Ctx & { context: { baseURL: string } };
					const { organizationId } = await authenticate(c);
					const team = await findTeam(organizationId, c.params?.groupId);
					return c.json(await resource(team, c.context.baseURL));
				},
			),

			replaceScimGroup: createAuthEndpoint(
				replace.path,
				replace.options as never,
				async (ctx) => {
					const c = ctx as unknown as Ctx & { context: { baseURL: string } };
					const { organizationId } = await authenticate(c);
					const team = await findTeam(organizationId, c.params?.groupId);
					const body = c.body as {
						displayName?: string;
						externalId?: string;
						members?: unknown;
					};
					await db
						.update(abhashTeam)
						.set({
							...(body.displayName ? { name: body.displayName } : {}),
							...(body.externalId !== undefined
								? { externalId: body.externalId }
								: {}),
						})
						.where(eq(abhashTeam.id, team.id));
					await setMembers(team, memberIds(body.members));
					return c.json(
						await resource(
							await findTeam(organizationId, team.id),
							c.context.baseURL,
						),
					);
				},
			),

			patchScimGroup: createAuthEndpoint(
				patch.path,
				patch.options as never,
				async (ctx) => {
					const c = ctx as unknown as Ctx & { context: { baseURL: string } };
					const { organizationId } = await authenticate(c);
					const team = await findTeam(organizationId, c.params?.groupId);
					const operations =
						(c.body as { Operations?: PatchOp[] }).Operations ?? [];
					await applyPatch(team, operations);
					return c.json(
						await resource(
							await findTeam(organizationId, team.id),
							c.context.baseURL,
						),
					);
				},
			),

			deleteScimGroup: createAuthEndpoint(
				remove.path,
				remove.options as never,
				async (ctx) => {
					const c = ctx as unknown as Ctx;
					const { organizationId } = await authenticate(c);
					const team = await findTeam(organizationId, c.params?.groupId);
					const members = await db.query.abhashTeamMember.findMany({
						where: eq(abhashTeamMember.teamId, team.id),
					});
					await db.delete(abhashTeam).where(eq(abhashTeam.id, team.id));
					await syncScimRoles(
						organizationId,
						members.map((m) => m.userId),
					);
					return new Response(null, { status: 204 });
				},
			),
		},
	} satisfies BetterAuthPlugin;
};
