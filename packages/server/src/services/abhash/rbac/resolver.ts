import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { db } from "../../../db";
import { abhashRoleBinding, member } from "../../../db/schema";
import type { BindingScope } from "../../../db/schema/abhash-rbac";
import {
	enterpriseOnlyResources,
	statements,
} from "../../../lib/access-control";
import { loadRole, ORG_ROLE, roleGrants, SCOPED_RESOURCES } from "./roles";
import {
	ancestry,
	applicableBindings,
	type Binding,
	bindingsFor,
	type ScopeRef,
	type Visibility,
	visibilityOf,
} from "./scope";

type Permissions = Record<string, readonly string[]>;
type Role = NonNullable<Awaited<ReturnType<typeof loadRole>>>;

export type RbacCtx = {
	user: { id: string };
	session: { activeOrganizationId: string };
	/** Set by withPermission: what the route itself requires. */
	abhashRequired?: Permissions;
};

type MemberRow = NonNullable<Awaited<ReturnType<typeof loadMemberRow>>>;

const loadMemberRow = (userId: string, organizationId: string) =>
	db.query.member.findFirst({
		where: and(
			eq(member.userId, userId),
			eq(member.organizationId, organizationId),
		),
		with: { user: true },
	});

const denied = (message = "Permission denied") =>
	new TRPCError({ code: "UNAUTHORIZED", message });

const requireMember = async (userId: string, organizationId: string) => {
	const row = await loadMemberRow(userId, organizationId);
	if (!row || row.user.banned) throw denied();
	return row;
};

const isPrivileged = (row: MemberRow) =>
	row.role === "owner" || row.role === "admin";

// The per-member switches that predate roles. Honoured for the built-in
// "member" role only, exactly as the legacy checks do.
const legacyOverrides = (row: MemberRow): Record<string, Set<string>> => {
	if (row.role !== "member") return {};
	const on = (flag: boolean | null, ...actions: string[]) =>
		flag ? actions : [];
	return Object.fromEntries(
		Object.entries({
			project: [
				...on(row.canCreateProjects, "create"),
				...on(row.canDeleteProjects, "delete"),
			],
			service: [
				...on(row.canCreateServices, "create"),
				...on(row.canDeleteServices, "delete"),
			],
			environment: [
				...on(row.canCreateEnvironments, "create"),
				...on(row.canDeleteEnvironments, "delete"),
			],
			traefikFiles: on(row.canAccessToTraefikFiles, "read"),
			docker: on(row.canAccessToDocker, "read"),
			api: on(row.canAccessToAPI, "read"),
			sshKeys: on(row.canAccessToSSHKeys, "read", "create", "delete"),
			gitProviders: on(row.canAccessToGitProviders, "read", "create", "delete"),
		}).map(([resource, actions]) => [resource, new Set(actions)]),
	);
};

const rolesFor = async (
	names: string[],
	row: MemberRow,
	organizationId: string,
): Promise<Role[]> => {
	const roles = await Promise.all(
		[...new Set(names.map((n) => (n === ORG_ROLE ? row.role : n)))].map((n) =>
			loadRole(n, organizationId),
		),
	);
	return roles.filter((r): r is Role => r !== null);
};

const grantedBy = (
	roles: Role[],
	overrides: Record<string, Set<string>>,
	resource: string,
	action: string,
) =>
	overrides[resource]?.has(action) ||
	roles.some((role) => roleGrants(role, resource, action));

const firstGap = (
	permissions: Permissions,
	granted: (resource: string, action: string) => boolean,
) => {
	for (const [resource, actions] of Object.entries(permissions)) {
		for (const action of actions) {
			if (!granted(resource, action)) return `${resource}:${action}`;
		}
	}
	return null;
};

// Matches the legacy engine: the roles must cover every requested action, or
// the legacy switches must; the two are never combined within one check.
const missing = (
	permissions: Permissions,
	roles: Role[],
	overrides: Record<string, Set<string>>,
) => {
	const roleGap = firstGap(permissions, (resource, action) =>
		roles.some((role) => roleGrants(role, resource, action)),
	);
	if (!roleGap) return null;
	const overrideGap = firstGap(
		permissions,
		(resource, action) => !!overrides[resource]?.has(action),
	);
	return overrideGap ? roleGap : null;
};

/** Owners and admins are checked exactly as the legacy engine does. */
const checkPrivileged = async (
	row: MemberRow,
	organizationId: string,
	permissions: Permissions,
) => {
	const allEnterprise = Object.keys(permissions).every((r) =>
		enterpriseOnlyResources.has(r),
	);
	if (allEnterprise) return;
	const [role] = await rolesFor([row.role], row, organizationId);
	if (!role || missing(permissions, [role], {})) throw denied();
};

const merge = (a: Permissions, b: Permissions | undefined): Permissions => {
	if (!b) return a;
	const out: Record<string, Set<string>> = {};
	for (const source of [a, b]) {
		for (const [resource, actions] of Object.entries(source)) {
			out[resource] ??= new Set();
			for (const action of actions) out[resource].add(action);
		}
	}
	return Object.fromEntries(Object.entries(out).map(([r, s]) => [r, [...s]]));
};

const scopedOnly = (permissions: Permissions | undefined): Permissions =>
	Object.fromEntries(
		Object.entries(permissions ?? {}).filter(([r]) => SCOPED_RESOURCES.has(r)),
	);

/**
 * Unscoped check ("may this member do X at all?"). Organization-level
 * resources come from the organization role; scoped resources also from any
 * binding, since the route will then check the specific target.
 */
export const checkPermission = async (
	ctx: RbacCtx,
	permissions: Permissions,
) => {
	const orgId = ctx.session.activeOrganizationId;
	const row = await requireMember(ctx.user.id, orgId);
	if (isPrivileged(row)) return checkPrivileged(row, orgId, permissions);

	const bindings = await bindingsFor(row.userId, orgId);
	const orgRoles = await rolesFor([row.role], row, orgId);
	const allRoles = await rolesFor(
		[row.role, ...bindings.map((b) => b.role)],
		row,
		orgId,
	);
	const overrides = legacyOverrides(row);
	const scoped = Object.fromEntries(
		Object.entries(permissions).filter(([r]) => SCOPED_RESOURCES.has(r)),
	);
	const orgLevel = Object.fromEntries(
		Object.entries(permissions).filter(([r]) => !SCOPED_RESOURCES.has(r)),
	);
	const roles = Object.keys(scoped).length ? allRoles : orgRoles;
	const gap =
		Object.keys(orgLevel).length && Object.keys(scoped).length
			? (missing(orgLevel, orgRoles, overrides) ??
				missing(scoped, allRoles, overrides))
			: missing(permissions, roles, overrides);
	if (gap) throw denied(`Missing permission ${gap}`);
};

/** Scoped check: the member needs `permissions` at `target` specifically. */
export const checkScoped = async (
	ctx: RbacCtx,
	target: ScopeRef,
	permissions: Permissions,
	message = "You don't have access to this resource",
) => {
	const orgId = ctx.session.activeOrganizationId;
	const row = await requireMember(ctx.user.id, orgId);
	const needed = merge(permissions, scopedOnly(ctx.abhashRequired));
	if (isPrivileged(row)) return checkPrivileged(row, orgId, needed);

	const chain = await ancestry(target);
	const applicable = applicableBindings(
		await bindingsFor(row.userId, orgId),
		chain,
	);
	if (applicable.length === 0) throw denied(message);
	const roles = await rolesFor(
		applicable.map((b) => b.role),
		row,
		orgId,
	);
	const gap = missing(needed, roles, legacyOverrides(row));
	if (gap) throw denied(`${message} (${gap})`);
};

export const resolvePermissions = async (ctx: RbacCtx) => {
	const orgId = ctx.session.activeOrganizationId;
	const row = await requireMember(ctx.user.id, orgId);
	const privileged = isPrivileged(row);
	const bindings = privileged ? [] : await bindingsFor(row.userId, orgId);
	const orgRoles = await rolesFor([row.role], row, orgId);
	const allRoles = await rolesFor(
		[row.role, ...bindings.map((b) => b.role)],
		row,
		orgId,
	);
	const overrides = legacyOverrides(row);
	const result: Record<string, Record<string, boolean>> = {};
	for (const [resource, actions] of Object.entries(statements)) {
		result[resource] = {};
		for (const action of actions) {
			result[resource][action] =
				(privileged && enterpriseOnlyResources.has(resource)) ||
				grantedBy(
					SCOPED_RESOURCES.has(resource) && !privileged ? allRoles : orgRoles,
					overrides,
					resource,
					action,
				);
		}
	}
	return result;
};

/**
 * The member row as the legacy engine returns it, with the access lists
 * computed from role bindings. Most listing code filters on these lists.
 */
export const findMemberWithAccess = async (
	userId: string,
	organizationId: string,
) => {
	const row = await requireMember(userId, organizationId);
	if (isPrivileged(row)) return row;
	const access = await accessOf(row, organizationId);
	return {
		...row,
		accessedProjects: access.projects,
		accessedEnvironments: access.environments,
		accessedServices: access.services,
		accessedServers: access.servers,
		accessedGitProviders: access.gitProviders,
	};
};

const accessOf = async (
	row: MemberRow,
	organizationId: string,
): Promise<Visibility> => {
	const bindings = await bindingsFor(row.userId, organizationId);
	const orgWide = bindings.filter(
		(b) => b.scopeType === "organization" && b.inherit,
	);
	const orgWideRoles = await rolesFor(
		orgWide.map((b) => b.role),
		row,
		organizationId,
	);
	return visibilityOf(bindings, organizationId, {
		seesAllServers: orgWideRoles.some((r) => roleGrants(r, "server", "read")),
		seesAllGitProviders: orgWideRoles.some((r) =>
			roleGrants(r, "gitProviders", "read"),
		),
	});
};

export const accessibleIds = async (
	userId: string,
	organizationId: string,
	kind: "servers" | "gitProviders",
) => {
	const row = await requireMember(userId, organizationId);
	if (isPrivileged(row)) {
		const all = await visibilityOf([], organizationId, {
			seesAllServers: kind === "servers",
			seesAllGitProviders: kind === "gitProviders",
		});
		return new Set(all[kind]);
	}
	return new Set((await accessOf(row, organizationId))[kind]);
};

/** Records that the creator of a resource can reach it, as the legacy lists do. */
export const grantCreator = async (
	ctx: RbacCtx,
	scopeType: BindingScope,
	scopeId: string,
) => {
	await db
		.insert(abhashRoleBinding)
		.values({
			organizationId: ctx.session.activeOrganizationId,
			subjectType: "user",
			subjectId: ctx.user.id,
			role: ORG_ROLE,
			scopeType,
			scopeId,
			inherit: false,
			source: "legacy",
			createdBy: ctx.user.id,
		})
		.onConflictDoNothing();
};

export type { Binding };
