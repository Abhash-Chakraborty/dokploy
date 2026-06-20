import { auditLog } from "@dokploy/server/db/schema";
import { and, desc, eq, gte, ilike, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { createTRPCRouter, withPermission } from "../../trpc";

const listInput = z.object({
	page: z.number().int().min(1).default(1),
	limit: z.number().int().min(10).max(100).default(25),
	search: z.string().trim().max(120).optional(),
	action: z.string().optional(),
	resourceType: z.string().optional(),
	userEmail: z.string().trim().max(160).optional(),
});

const buildWhere = (
	organizationId: string,
	input: z.infer<typeof listInput>,
) => {
	const filters: SQL[] = [eq(auditLog.organizationId, organizationId)];

	if (input.action && input.action !== "all") {
		filters.push(eq(auditLog.action, input.action));
	}

	if (input.resourceType && input.resourceType !== "all") {
		filters.push(eq(auditLog.resourceType, input.resourceType));
	}

	if (input.userEmail) {
		filters.push(ilike(auditLog.userEmail, `%${input.userEmail}%`));
	}

	if (input.search) {
		const term = `%${input.search}%`;
		const searchFilter = or(
			ilike(auditLog.userEmail, term),
			ilike(auditLog.userRole, term),
			ilike(auditLog.action, term),
			ilike(auditLog.resourceType, term),
			ilike(sql<string>`coalesce(${auditLog.resourceId}, '')`, term),
			ilike(sql<string>`coalesce(${auditLog.resourceName}, '')`, term),
			ilike(sql<string>`coalesce(${auditLog.metadata}, '')`, term),
		);

		if (searchFilter) {
			filters.push(searchFilter);
		}
	}

	return and(...filters);
};

export const abhashAuditLogRouter = createTRPCRouter({
	all: withPermission("auditLog", "read")
		.input(z.any().optional())
		.query(async ({ ctx }): Promise<any> => {
			const where = eq(auditLog.organizationId, ctx.session.activeOrganizationId);
			const rows = await ctx.db
				.select()
				.from(auditLog)
				.where(where)
				.orderBy(desc(auditLog.createdAt))
				.limit(100);

			return {
				rows,
				page: 1,
				limit: 100,
				total: rows.length,
				totalPages: 1,
			};
		}),

	list: withPermission("auditLog", "read")
		.input(listInput)
		.query(async ({ ctx, input }) => {
			const where = buildWhere(ctx.session.activeOrganizationId, input);
			const offset = (input.page - 1) * input.limit;

			const [rows, totalRows] = await Promise.all([
				ctx.db
					.select()
					.from(auditLog)
					.where(where)
					.orderBy(desc(auditLog.createdAt))
					.limit(input.limit)
					.offset(offset),
				ctx.db.select({ count: sql<number>`count(*)::int` }).from(auditLog).where(where),
			]);

			const total = totalRows[0]?.count ?? 0;

			return {
				rows,
				page: input.page,
				limit: input.limit,
				total,
				totalPages: Math.max(1, Math.ceil(total / input.limit)),
			};
		}),

	summary: withPermission("auditLog", "read").query(async ({ ctx }) => {
		const organizationId = ctx.session.activeOrganizationId;
		const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
		const orgFilter = eq(auditLog.organizationId, organizationId);

		const [totalRows, dayRows, actionRows, resourceRows] = await Promise.all([
			ctx.db
				.select({ count: sql<number>`count(*)::int` })
				.from(auditLog)
				.where(orgFilter),
			ctx.db
				.select({ count: sql<number>`count(*)::int` })
				.from(auditLog)
				.where(and(orgFilter, gte(auditLog.createdAt, since))),
			ctx.db
				.select({
					action: auditLog.action,
					count: sql<number>`count(*)::int`,
				})
				.from(auditLog)
				.where(orgFilter)
				.groupBy(auditLog.action)
				.orderBy(sql`count(*) desc`)
				.limit(12),
			ctx.db
				.select({
					resourceType: auditLog.resourceType,
					count: sql<number>`count(*)::int`,
				})
				.from(auditLog)
				.where(orgFilter)
				.groupBy(auditLog.resourceType)
				.orderBy(sql`count(*) desc`)
				.limit(12),
		]);

		return {
			total: totalRows[0]?.count ?? 0,
			last24Hours: dayRows[0]?.count ?? 0,
			actions: actionRows,
			resources: resourceRows,
		};
	}),
});
