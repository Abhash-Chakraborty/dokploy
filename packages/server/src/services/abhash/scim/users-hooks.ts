import { APIError } from "better-auth/api";
import { and, eq } from "drizzle-orm";
import { db } from "../../../db";
import { abhashUserSuspension, member, user } from "../../../db/schema";
import { createAuditLog } from "../audit-log";
import { isFlagEnabled } from "../flags";
import { reactivateUser, suspendUser } from "../suspension";
import { verifyScimBearer } from "./tokens";

type HookCtx = {
	path?: string;
	request?: Request;
	params?: Record<string, string>;
	body?: unknown;
	headers?: Headers;
};

const USER_PATH = "/scim/v2/Users/:userId";

const deactivates = (body: unknown) => {
	const b = body as {
		active?: unknown;
		Operations?: { op?: string; path?: string; value?: unknown }[];
	} | null;
	if (b?.active === false) return true;
	return (b?.Operations ?? []).some(
		(o) =>
			o.op?.toLowerCase() === "replace" &&
			((o.path?.toLowerCase() === "active" &&
				(o.value === false || o.value === "false")) ||
				(!o.path &&
					(o.value as { active?: unknown } | undefined)?.active === false)),
	);
};

const isOwnerIn = async (userId: string, organizationId: string) =>
	!!(await db.query.member.findFirst({
		where: and(
			eq(member.userId, userId),
			eq(member.organizationId, organizationId),
			eq(member.role, "owner"),
		),
	}));

/**
 * Runs before the SCIM plugin's user endpoints. Returns a response to
 * short-circuit the endpoint, or undefined to let it run.
 */
export const scimUsersBefore = async (ctx: HookCtx) => {
	const path = ctx.path ?? "";
	if (!path.startsWith("/scim/v2/")) return;
	if (!(await isFlagEnabled("scim.enabled"))) throw new APIError("NOT_FOUND");
	if (path !== USER_PATH) return;
	const method = ctx.request?.method;
	const userId = ctx.params?.userId;
	if (
		!userId ||
		(method !== "DELETE" && method !== "PATCH" && method !== "PUT")
	)
		return;

	const connection = await verifyScimBearer(ctx.headers?.get("authorization"));
	// Let the plugin produce its own 401 for bad tokens.
	if (!connection) return;
	const inOrg = await db.query.member.findFirst({
		where: and(
			eq(member.userId, userId),
			eq(member.organizationId, connection.organizationId),
		),
	});
	if (!inOrg) return;

	if (
		inOrg.role === "owner" &&
		(method === "DELETE" || deactivates(ctx.body))
	) {
		throw new APIError("BAD_REQUEST", {
			detail: "An organization owner cannot be deactivated through SCIM",
		});
	}

	// Deprovisioning keeps the account, its history and its resources: the
	// user is suspended instead of removed. An admin can remove them later.
	if (method === "DELETE") {
		await suspendUser({
			userId,
			actorId: null,
			source: "scim",
			reason: "Deprovisioned via SCIM",
		});
		const target = await db.query.user.findFirst({
			where: eq(user.id, userId),
		});
		await createAuditLog({
			organizationId: connection.organizationId,
			userEmail: `scim:${connection.providerId}`,
			userRole: "system",
			action: "suspend",
			resourceType: "user",
			resourceId: userId,
			resourceName: target?.email,
			metadata: { via: "SCIM DELETE" },
		});
		return new Response(null, { status: 204 });
	}
};

/**
 * After a SCIM user update, align the fork's suspension (API keys, record)
 * with the plugin's `banned` flag, which is what `active` maps to.
 */
export const scimUsersAfter = async (ctx: HookCtx) => {
	if (ctx.path !== USER_PATH) return;
	const method = ctx.request?.method;
	if (method !== "PATCH" && method !== "PUT") return;
	const userId = ctx.params?.userId;
	if (!userId) return;
	const connection = await verifyScimBearer(ctx.headers?.get("authorization"));
	if (!connection) return;
	const target = await db.query.user.findFirst({ where: eq(user.id, userId) });
	if (!target) return;
	const record = await db.query.abhashUserSuspension.findFirst({
		where: eq(abhashUserSuspension.userId, userId),
	});
	if (
		target.banned &&
		!record &&
		!(await isOwnerIn(userId, connection.organizationId))
	) {
		await suspendUser({
			userId,
			actorId: null,
			source: "scim",
			reason: "Deactivated via SCIM",
		});
	} else if (!target.banned && record?.source === "scim") {
		await reactivateUser({ userId, actorId: null });
	}
};
