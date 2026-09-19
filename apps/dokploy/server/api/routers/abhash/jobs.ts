import { db } from "@dokploy/server/db";
import { abhashJob } from "@dokploy/server/db/schema";
import { isFlagEnabled } from "@dokploy/server/services/abhash/flags";
import {
	areJobWorkersRunning,
	cancelJob,
	enqueueJob,
	isRedisReachable,
	JobEngineUnavailableError,
	jobTypes,
	readJobLog,
	setJobEngineEnabled,
} from "@dokploy/server/services/abhash/jobs";
import { TRPCError } from "@trpc/server";
import {
	and,
	desc,
	eq,
	inArray,
	isNull,
	lt,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
} from "../../trpc";

const STATUSES = [
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
	"interrupted",
] as const;

type Ctx = {
	user: { id: string; role: string; email: string };
	session: { activeOrganizationId: string };
};

const isAdmin = (ctx: Ctx) =>
	ctx.user.role === "owner" || ctx.user.role === "admin";

/** Admins see the organization's jobs and system jobs; others only their own. */
const visibleTo = (ctx: Ctx): SQL => {
	const inOrg = eq(abhashJob.organizationId, ctx.session.activeOrganizationId);
	if (isAdmin(ctx)) {
		return or(inOrg, isNull(abhashJob.organizationId)) as SQL;
	}
	return and(inOrg, sql`${abhashJob.actor}->>'id' = ${ctx.user.id}`) as SQL;
};

const findVisible = async (ctx: Ctx, id: string) => {
	const row = await db.query.abhashJob.findFirst({
		where: and(eq(abhashJob.id, id), visibleTo(ctx)),
	});
	if (!row)
		throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" });
	return row;
};

const asTrpcError = (error: unknown) =>
	error instanceof JobEngineUnavailableError
		? new TRPCError({ code: "SERVICE_UNAVAILABLE", message: error.message })
		: error;

export const abhashJobsRouter = createTRPCRouter({
	status: protectedProcedure.query(async () => {
		const enabled = await isFlagEnabled("jobs.enabled");
		return {
			enabled,
			running: areJobWorkersRunning(),
			redisReachable: enabled ? await isRedisReachable() : null,
		};
	}),

	setEnabled: adminProcedure
		.input(z.object({ enabled: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			if (ctx.user.role !== "owner") {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Only the organization owner can change this",
				});
			}
			try {
				await setJobEngineEnabled(input.enabled, ctx.user.id);
			} catch (error) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: error instanceof Error ? error.message : String(error),
				});
			}
			await audit(ctx, {
				action: "update",
				resourceType: "featureFlag",
				resourceName: "jobs.enabled",
				metadata: input,
			});
			return true;
		}),

	list: protectedProcedure
		.input(
			z.object({
				status: z.array(z.enum(STATUSES)).optional(),
				type: z.string().optional(),
				targetType: z.string().optional(),
				targetId: z.string().optional(),
				limit: z.number().int().min(1).max(100).default(30),
				before: z.string().datetime().optional(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const filters: SQL[] = [visibleTo(ctx)];
			if (input.status?.length)
				filters.push(inArray(abhashJob.status, input.status));
			if (input.type) filters.push(eq(abhashJob.type, input.type));
			if (input.targetType)
				filters.push(eq(abhashJob.targetType, input.targetType));
			if (input.targetId) filters.push(eq(abhashJob.targetId, input.targetId));
			if (input.before)
				filters.push(lt(abhashJob.createdAt, new Date(input.before)));
			const rows = await db.query.abhashJob.findMany({
				where: and(...filters),
				orderBy: [desc(abhashJob.createdAt)],
				limit: input.limit,
				columns: { input: false, result: false },
			});
			const [active] = await db
				.select({ n: sql<number>`count(*)::int` })
				.from(abhashJob)
				.where(
					and(visibleTo(ctx), inArray(abhashJob.status, ["queued", "running"])),
				);
			return { jobs: rows, active: active?.n ?? 0 };
		}),

	get: protectedProcedure
		.input(z.object({ id: z.string() }))
		.query(({ ctx, input }) => findVisible(ctx, input.id)),

	log: protectedProcedure
		.input(
			z.object({ id: z.string(), offset: z.number().int().min(0).default(0) }),
		)
		.query(async ({ ctx, input }) => {
			const row = await findVisible(ctx, input.id);
			return {
				...(await readJobLog(row.id, input.offset)),
				status: row.status,
			};
		}),

	cancel: protectedProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const row = await findVisible(ctx, input.id);
			const cancelled = await cancelJob(row.id);
			await audit(ctx, {
				action: "cancel",
				resourceType: "job",
				resourceId: row.id,
				resourceName: row.title,
			});
			return cancelled;
		}),

	retry: adminProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const row = await findVisible(ctx, input.id);
			if (row.status === "queued" || row.status === "running") {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "The job has not finished yet",
				});
			}
			try {
				const job = await enqueueJob(row.type, row.input, {
					actor: { type: "user", id: ctx.user.id, name: ctx.user.email },
					organizationId: row.organizationId,
				});
				await audit(ctx, {
					action: "run",
					resourceType: "job",
					resourceId: job.id,
					resourceName: job.title,
					metadata: { retryOf: row.id },
				});
				return job;
			} catch (error) {
				throw asTrpcError(error);
			}
		}),

	selfTest: adminProcedure.mutation(async ({ ctx }) => {
		try {
			return await enqueueJob(
				"system.echo",
				{ message: "Job engine is working", steps: 5 },
				{
					actor: { type: "user", id: ctx.user.id, name: ctx.user.email },
					organizationId: ctx.session.activeOrganizationId,
				},
			);
		} catch (error) {
			throw asTrpcError(error);
		}
	}),

	types: adminProcedure.query(() => jobTypes()),
});
