import {
	getAllBackupsForOrganization,
	getAllDomainsForOrganization,
	getAllServicesForOrganization,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { deployments } from "@dokploy/server/db/schema/deployment";
import {
	findMemberByUserId,
	hasPermission,
} from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { and, gte, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { createTRPCRouter, protectedProcedure, withPermission } from "../trpc";

/** Local date key (YYYY-MM-DD) used to bucket a deployment. */
const dayKey = (iso: string) => iso.slice(0, 10);

/**
 * Every day in the range, oldest first. Days with no deployments must still
 * appear, otherwise the chart silently compresses quiet periods and reads as
 * busier than reality.
 */
const buildDayRange = (rangeDays: number) => {
	const days: string[] = [];
	const today = new Date();
	for (let offset = rangeDays - 1; offset >= 0; offset--) {
		const day = new Date(today);
		day.setDate(today.getDate() - offset);
		days.push(day.toISOString().slice(0, 10));
	}
	return days;
};

export const overviewRouter = createTRPCRouter({
	services: withPermission("service", "read").query(async ({ ctx }) => {
		const orgId = ctx.session.activeOrganizationId;
		const accessedServices =
			ctx.user.role !== "owner" && ctx.user.role !== "admin"
				? (await findMemberByUserId(ctx.user.id, orgId)).accessedServices
				: null;
		return getAllServicesForOrganization(orgId, accessedServices);
	}),

	// Reads backup and/or volumeBackup run history depending on which the user can see.
	backups: protectedProcedure.query(async ({ ctx }) => {
		const [canReadBackups, canReadVolumeBackups] = await Promise.all([
			hasPermission(ctx, { backup: ["read"] }),
			hasPermission(ctx, { volumeBackup: ["read"] }),
		]);
		if (!canReadBackups && !canReadVolumeBackups) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "You don't have access to backups or volume backups",
			});
		}
		const orgId = ctx.session.activeOrganizationId;
		const accessedServices =
			ctx.user.role !== "owner" && ctx.user.role !== "admin"
				? (await findMemberByUserId(ctx.user.id, orgId)).accessedServices
				: null;
		return getAllBackupsForOrganization(orgId, accessedServices, {
			backup: canReadBackups,
			volumeBackup: canReadVolumeBackups,
		});
	}),

	/**
	 * Aggregates for the analytics page. Everything here comes from rows that
	 * already exist -- deployments and the service inventory. Dokploy keeps live
	 * CPU/memory in a separate monitoring service and does not persist it, so
	 * this deliberately charts no resource history.
	 */
	analytics: withPermission("service", "read")
		.input(
			z.object({
				rangeDays: z.union([z.literal(7), z.literal(30), z.literal(90)]),
			}),
		)
		.query(async ({ ctx, input }) => {
			const orgId = ctx.session.activeOrganizationId;
			const accessedServices =
				ctx.user.role !== "owner" && ctx.user.role !== "admin"
					? (await findMemberByUserId(ctx.user.id, orgId)).accessedServices
					: null;

			const services = await getAllServicesForOrganization(
				orgId,
				accessedServices,
			);

			const applicationIds = services
				.filter((service) => service.type === "application")
				.map((service) => service.id);
			const composeIds = services
				.filter((service) => service.type === "compose")
				.map((service) => service.id);

			const days = buildDayRange(input.rangeDays);
			const since = `${days[0]}T00:00:00.000Z`;

			// Only applications and composes own deployments; if the caller can see
			// neither, there is nothing to aggregate.
			const ownerFilters = [
				applicationIds.length
					? inArray(deployments.applicationId, applicationIds)
					: undefined,
				composeIds.length
					? inArray(deployments.composeId, composeIds)
					: undefined,
			].filter((filter) => filter !== undefined);

			const rows = ownerFilters.length
				? await db
						.select({
							status: deployments.status,
							createdAt: deployments.createdAt,
							applicationId: deployments.applicationId,
							composeId: deployments.composeId,
						})
						.from(deployments)
						.where(and(gte(deployments.createdAt, since), or(...ownerFilters)))
				: [];

			const emptyBucket = () => ({
				done: 0,
				error: 0,
				running: 0,
				cancelled: 0,
				total: 0,
			});
			const buckets = new Map(days.map((day) => [day, emptyBucket()]));
			const byStatus = emptyBucket();
			const perService = new Map<string, number>();

			for (const row of rows) {
				const bucket = buckets.get(dayKey(row.createdAt));
				const status = (row.status ?? "running") as keyof typeof byStatus;
				if (bucket && status in bucket) {
					bucket[status] += 1;
					bucket.total += 1;
				}
				if (status in byStatus) byStatus[status] += 1;
				byStatus.total += 1;

				const serviceId = row.applicationId ?? row.composeId;
				if (serviceId) {
					perService.set(serviceId, (perService.get(serviceId) ?? 0) + 1);
				}
			}

			const deploymentsOverTime = days.map((day) => ({
				day,
				...(buckets.get(day) ?? emptyBucket()),
			}));

			const busiest = deploymentsOverTime.reduce(
				(best, current) => (current.total > best.total ? current : best),
				{ day: days[0] ?? "", total: 0 },
			);

			const serviceById = new Map(
				services.map((service) => [service.id, service]),
			);
			const topProjects = [...perService.entries()]
				.reduce((acc, [serviceId, count]) => {
					const service = serviceById.get(serviceId);
					if (!service) return acc;
					acc.set(service.projectId, (acc.get(service.projectId) ?? 0) + count);
					return acc;
				}, new Map<string, number>())
				.entries();

			const projectNameById = new Map(
				services.map((service) => [service.projectId, service.projectName]),
			);

			const inventoryByType = services.reduce<Record<string, number>>(
				(acc, service) => {
					acc[service.type] = (acc[service.type] ?? 0) + 1;
					return acc;
				},
				{},
			);

			const inventoryByState = services.reduce(
				(acc, service) => {
					const status = service.status ?? "idle";
					if (status === "running") acc.running += 1;
					else if (status === "error") acc.errored += 1;
					else acc.idle += 1;
					return acc;
				},
				{ running: 0, errored: 0, idle: 0 },
			);

			return {
				rangeDays: input.rangeDays,
				deploymentsOverTime,
				deploymentsByStatus: byStatus,
				serviceInventory: {
					total: services.length,
					byType: inventoryByType,
					byState: inventoryByState,
				},
				topProjects: [...topProjects]
					.map(([projectId, count]) => ({
						projectId,
						projectName: projectNameById.get(projectId) ?? "Unknown project",
						deployments: count,
					}))
					.sort((a, b) => b.deployments - a.deployments)
					.slice(0, 8),
				totals: {
					deployments: byStatus.total,
					successRate:
						byStatus.total === 0
							? null
							: Math.round((byStatus.done / byStatus.total) * 100),
					busiestDay: busiest.total > 0 ? busiest.day : null,
					busiestDayCount: busiest.total,
				},
			};
		}),

	domains: withPermission("domain", "read").query(async ({ ctx }) => {
		const orgId = ctx.session.activeOrganizationId;
		const accessedServices =
			ctx.user.role !== "owner" && ctx.user.role !== "admin"
				? (await findMemberByUserId(ctx.user.id, orgId)).accessedServices
				: null;
		return getAllDomainsForOrganization(orgId, accessedServices);
	}),
});
