import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
	abhashUserSuspension,
	apikey,
	member,
	session,
	user,
} from "../../db/schema";
import type { AbhashSource } from "../../db/schema/abhash-rbac";

const fail = (message: string) =>
	new TRPCError({ code: "BAD_REQUEST", message });

/**
 * A suspension blocks the user everywhere, so the actor must be an owner or
 * admin of every organization the user belongs to, and owners cannot be
 * suspended at all (an organization must keep one).
 */
const assertCanManage = async (actorId: string, targetId: string) => {
	if (actorId === targetId) throw fail("You cannot suspend yourself");
	const [targetMemberships, actorMemberships] = await Promise.all([
		db.query.member.findMany({ where: eq(member.userId, targetId) }),
		db.query.member.findMany({ where: eq(member.userId, actorId) }),
	]);
	if (targetMemberships.some((m) => m.role === "owner")) {
		throw fail("An organization owner cannot be suspended");
	}
	const managed = new Set(
		actorMemberships
			.filter((m) => m.role === "owner" || m.role === "admin")
			.map((m) => m.organizationId),
	);
	if (targetMemberships.some((m) => !managed.has(m.organizationId))) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message:
				"This user also belongs to an organization you do not administer",
		});
	}
};

export const suspendUser = async (input: {
	userId: string;
	actorId: string | null;
	source: AbhashSource;
	reason?: string;
}) => {
	if (input.actorId) await assertCanManage(input.actorId, input.userId);

	await db.transaction(async (tx) => {
		const keys = await tx.query.apikey.findMany({
			where: and(
				eq(apikey.referenceId, input.userId),
				eq(apikey.enabled, true),
			),
			columns: { id: true },
		});
		const keyIds = keys.map((k) => k.id);
		if (keyIds.length) {
			await tx
				.update(apikey)
				.set({ enabled: false })
				.where(inArray(apikey.id, keyIds));
		}
		await tx
			.update(user)
			.set({ banned: true, banReason: input.reason ?? "Suspended" })
			.where(eq(user.id, input.userId));
		await tx.delete(session).where(eq(session.userId, input.userId));
		await tx
			.insert(abhashUserSuspension)
			.values({
				userId: input.userId,
				suspendedBy: input.actorId,
				source: input.source,
				reason: input.reason,
				disabledApiKeyIds: keyIds,
			})
			.onConflictDoUpdate({
				target: abhashUserSuspension.userId,
				set: {
					suspendedAt: new Date(),
					suspendedBy: input.actorId,
					source: input.source,
					reason: input.reason,
				},
			});
	});
};

export const reactivateUser = async (input: {
	userId: string;
	actorId: string | null;
}) => {
	if (input.actorId) await assertCanManage(input.actorId, input.userId);

	await db.transaction(async (tx) => {
		const record = await tx.query.abhashUserSuspension.findFirst({
			where: eq(abhashUserSuspension.userId, input.userId),
		});
		if (record?.disabledApiKeyIds.length) {
			await tx
				.update(apikey)
				.set({ enabled: true })
				.where(inArray(apikey.id, record.disabledApiKeyIds));
		}
		await tx
			.update(user)
			.set({ banned: false, banReason: null, banExpires: null })
			.where(eq(user.id, input.userId));
		await tx
			.delete(abhashUserSuspension)
			.where(eq(abhashUserSuspension.userId, input.userId));
	});
};
