import { db } from "@dokploy/server/db";
import {
	abhashBackupPolicy,
	abhashBackupRepository,
	abhashBackupRun,
	abhashDrillPolicy,
	abhashDrillRun,
	DEFAULT_RETENTION,
} from "@dokploy/server/db/schema";
import {
	type Actor,
	enqueueJobForActor,
} from "@dokploy/server/services/abhash/agents";
import {
	findPolicy,
	initRepository,
	listSnapshots,
	syncBackupSchedule,
	syncDrillSchedule,
} from "@dokploy/server/services/abhash/backups";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { adminProcedure, createTRPCRouter } from "../../trpc";

const asTrpc = (error: unknown) =>
	new TRPCError({
		code: "BAD_REQUEST",
		message: error instanceof Error ? error.message : String(error),
	});

const retentionInput = z.object({
	last: z.number().int().min(0).max(1000),
	daily: z.number().int().min(0).max(1000),
	weekly: z.number().int().min(0).max(1000),
	monthly: z.number().int().min(0).max(1000),
	yearly: z.number().int().min(0).max(1000),
});

const actorOf = (ctx: {
	actor?: Actor;
	user: { id: string; email: string };
}): Actor =>
	ctx.actor ?? { type: "user", id: ctx.user.id, name: ctx.user.email };

export const abhashBackupsRouter = createTRPCRouter({
	/** Everything the backup health page shows, in one call. */
	overview: adminProcedure.query(async ({ ctx }) => {
		const organizationId = ctx.session.activeOrganizationId;
		const repositories = await db.query.abhashBackupRepository.findMany({
			where: eq(abhashBackupRepository.organizationId, organizationId),
		});
		const policies = await db.query.abhashBackupPolicy.findMany({
			where: eq(abhashBackupPolicy.organizationId, organizationId),
		});
		const drills = await db.query.abhashDrillPolicy.findMany({
			where: eq(abhashDrillPolicy.organizationId, organizationId),
		});
		const policyIds = policies.map((policy) => policy.id);
		const runs = policyIds.length
			? await db.query.abhashBackupRun.findMany({
					where: inArray(abhashBackupRun.policyId, policyIds),
					orderBy: [desc(abhashBackupRun.startedAt)],
					limit: 200,
				})
			: [];
		const drillIds = drills.map((drill) => drill.id);
		const drillRuns = drillIds.length
			? await db.query.abhashDrillRun.findMany({
					where: inArray(abhashDrillRun.drillPolicyId, drillIds),
					orderBy: [desc(abhashDrillRun.startedAt)],
					limit: 200,
				})
			: [];

		const now = Date.now();
		return {
			repositories,
			policies: policies.map((policy) => {
				const mine = runs.filter((run) => run.policyId === policy.id);
				const lastSuccess = mine.find((run) => run.status === "succeeded");
				const drill = drills.find((row) => row.policyId === policy.id) ?? null;
				const lastDrill = drill
					? (drillRuns.find((run) => run.drillPolicyId === drill.id) ?? null)
					: null;
				const ageHours = lastSuccess
					? (now - new Date(lastSuccess.startedAt).getTime()) / 3_600_000
					: null;
				return {
					...policy,
					drill,
					lastRun: mine[0] ?? null,
					lastSuccess: lastSuccess ?? null,
					lastDrill,
					// "Stale" is the honest signal: a backup that exists but is too
					// old is not protection.
					stale: ageHours === null || ageHours > policy.rpoHours,
					ageHours,
				};
			}),
		};
	}),

	saveRepository: adminProcedure
		.input(
			z.object({
				id: z.string().optional(),
				name: z.string().trim().min(1).max(60),
				repository: z.string().trim().min(3).max(300),
				passwordRef: z.string().trim().min(1).max(200),
				env: z.record(z.string(), z.string()).default({}),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const { id, ...values } = input;
			const [row] = id
				? await db
						.update(abhashBackupRepository)
						.set(values)
						.where(
							and(
								eq(abhashBackupRepository.id, id),
								eq(abhashBackupRepository.organizationId, organizationId),
							),
						)
						.returning()
				: await db
						.insert(abhashBackupRepository)
						.values({ ...values, organizationId })
						.returning();
			if (!row) throw new TRPCError({ code: "NOT_FOUND" });
			await audit(ctx, {
				action: id ? "update" : "create",
				resourceType: "destination",
				resourceId: row.id,
				resourceName: `backup repository ${row.name}`,
			});
			return row;
		}),

	initRepository: adminProcedure
		.input(
			z.object({
				id: z.string(),
				serverId: z.string().nullable().default(null),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				return await initRepository(
					ctx.session.activeOrganizationId,
					input.id,
					input.serverId,
				);
			} catch (error) {
				throw asTrpc(error);
			}
		}),

	savePolicy: adminProcedure
		.input(
			z.object({
				id: z.string().optional(),
				name: z.string().trim().min(1).max(60),
				serverId: z.string().nullable().default(null),
				targetKind: z.enum([
					"postgres",
					"mysql",
					"mariadb",
					"mongo",
					"redis",
					"volume",
					"path",
					"dokploy",
				]),
				target: z.string().trim().min(1).max(200),
				repositoryId: z.string(),
				copyToRepositoryIds: z.array(z.string()).default([]),
				cronExpression: z.string().trim().max(120).nullable().default(null),
				timezone: z.string().trim().max(60).default("UTC"),
				retention: retentionInput.default(DEFAULT_RETENTION),
				rpoHours: z.number().int().min(1).max(8760).default(26),
				stopService: z.boolean().default(false),
				preHook: z.string().trim().max(2000).nullable().default(null),
				postHook: z.string().trim().max(2000).nullable().default(null),
				enabled: z.boolean().default(true),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const { id, ...values } = input;
			const [row] = id
				? await db
						.update(abhashBackupPolicy)
						.set(values)
						.where(
							and(
								eq(abhashBackupPolicy.id, id),
								eq(abhashBackupPolicy.organizationId, organizationId),
							),
						)
						.returning()
				: await db
						.insert(abhashBackupPolicy)
						.values({ ...values, organizationId })
						.returning();
			if (!row) throw new TRPCError({ code: "NOT_FOUND" });
			await syncBackupSchedule(organizationId, row.id).catch(() => false);
			await audit(ctx, {
				action: id ? "update" : "create",
				resourceType: "backup",
				resourceId: row.id,
				resourceName: row.name,
			});
			return row;
		}),

	removePolicy: adminProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			await db
				.delete(abhashBackupPolicy)
				.where(
					and(
						eq(abhashBackupPolicy.id, input.id),
						eq(
							abhashBackupPolicy.organizationId,
							ctx.session.activeOrganizationId,
						),
					),
				);
			await audit(ctx, {
				action: "delete",
				resourceType: "backup",
				resourceId: input.id,
				resourceName: "backup policy",
			});
			return true;
		}),

	saveDrill: adminProcedure
		.input(
			z.object({
				id: z.string().optional(),
				policyId: z.string(),
				where: z
					.enum(["isolated-local", "drill-server"])
					.default("isolated-local"),
				drillServerId: z.string().nullable().default(null),
				cronExpression: z.string().trim().max(120).nullable().default(null),
				timezone: z.string().trim().max(60).default("UTC"),
				rtoMinutes: z.number().int().min(1).max(1440).default(30),
				queries: z
					.array(
						z.object({
							name: z.string().trim().min(1).max(60),
							sql: z.string().trim().min(1).max(1000),
							expect: z.string().trim().max(200).optional(),
						}),
					)
					.default([]),
				enabled: z.boolean().default(true),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			await findPolicy(organizationId, input.policyId).catch((error) => {
				throw asTrpc(error);
			});
			const { id, ...values } = input;
			const [row] = id
				? await db
						.update(abhashDrillPolicy)
						.set(values)
						.where(
							and(
								eq(abhashDrillPolicy.id, id),
								eq(abhashDrillPolicy.organizationId, organizationId),
							),
						)
						.returning()
				: await db
						.insert(abhashDrillPolicy)
						.values({ ...values, organizationId })
						.returning();
			if (!row) throw new TRPCError({ code: "NOT_FOUND" });
			await syncDrillSchedule(organizationId, row.id).catch(() => false);
			return row;
		}),

	snapshots: adminProcedure
		.input(z.object({ policyId: z.string() }))
		.query(async ({ ctx, input }) => {
			try {
				return await listSnapshots(
					ctx.session.activeOrganizationId,
					input.policyId,
				);
			} catch (error) {
				throw asTrpc(error);
			}
		}),

	runNow: adminProcedure
		.input(z.object({ policyId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			await findPolicy(organizationId, input.policyId).catch((error) => {
				throw asTrpc(error);
			});
			const queued = await enqueueJobForActor(
				"backup.run",
				{ organizationId, policyId: input.policyId },
				{ actor: actorOf(ctx), organizationId },
			);
			await audit(ctx, {
				action: "run",
				resourceType: "backup",
				resourceId: input.policyId,
				resourceName: "backup",
			});
			return {
				jobId: queued.job?.id ?? null,
				approvalId: queued.approval?.id ?? null,
			};
		}),

	runDrill: adminProcedure
		.input(z.object({ drillPolicyId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const queued = await enqueueJobForActor(
				"backup.drill",
				{ organizationId, drillPolicyId: input.drillPolicyId },
				{ actor: actorOf(ctx), organizationId },
			);
			await audit(ctx, {
				action: "run",
				resourceType: "backup",
				resourceId: input.drillPolicyId,
				resourceName: "restore drill",
			});
			return {
				jobId: queued.job?.id ?? null,
				approvalId: queued.approval?.id ?? null,
			};
		}),

	checkRepository: adminProcedure
		.input(
			z.object({
				repositoryId: z.string(),
				serverId: z.string().nullable().default(null),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const queued = await enqueueJobForActor(
				"backup.check",
				{ organizationId, ...input, readDataPercent: 5 },
				{ actor: actorOf(ctx), organizationId },
			);
			return {
				jobId: queued.job?.id ?? null,
				approvalId: queued.approval?.id ?? null,
			};
		}),
});
