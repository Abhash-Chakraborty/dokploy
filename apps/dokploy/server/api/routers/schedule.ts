import { IS_CLOUD, removeScheduleJob, scheduleJob } from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { deployments } from "@dokploy/server/db/schema/deployment";
import {
	createScheduleSchema,
	schedules,
	updateScheduleSchema,
} from "@dokploy/server/db/schema/schedule";
import { runCommand } from "@dokploy/server/index";
import {
	checkPermission,
	checkServicePermissionAndAccess,
	findMemberByUserId,
} from "@dokploy/server/services/permission";
import {
	assertHostScheduleAccess,
	createSchedule,
	deleteSchedule,
	findScheduleById,
	updateSchedule,
} from "@dokploy/server/services/schedule";
import { findServerById } from "@dokploy/server/services/server";
import { TRPCError } from "@trpc/server";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { assertScheduledJobLimit } from "@/server/api/utils/plan-limits";
import { removeJob, schedule } from "@/server/utils/backup";
import { createTRPCRouter, protectedProcedure } from "../trpc";

export const scheduleRouter = createTRPCRouter({
	create: protectedProcedure
		.input(createScheduleSchema)
		.mutation(async ({ input, ctx }) => {
			await assertHostScheduleAccess(ctx, input.scheduleType, input.serverId);

			const serviceId = input.applicationId || input.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					schedule: ["create"],
				});
				if (IS_CLOUD) {
					await assertScheduledJobLimit(
						ctx.session.activeOrganizationId,
						input.applicationId ? "application" : "compose",
						serviceId,
					);
				}
			} else {
				await checkPermission(ctx, { schedule: ["create"] });

				if (IS_CLOUD && input.scheduleType === "server" && input.serverId) {
					await assertScheduledJobLimit(
						ctx.session.activeOrganizationId,
						"server",
						input.serverId,
					);
				}
			}
			const newSchedule = await createSchedule({
				...input,
				...(input.scheduleType === "dokploy-server" && {
					organizationId: ctx.session.activeOrganizationId,
				}),
			});

			if (newSchedule?.enabled) {
				if (IS_CLOUD) {
					schedule({
						scheduleId: newSchedule.scheduleId,
						type: "schedule",
						cronSchedule: newSchedule.cronExpression,
						timezone: newSchedule.timezone,
					});
				} else {
					scheduleJob(newSchedule);
				}
			}
			await audit(ctx, {
				action: "create",
				resourceType: "schedule",
				resourceId: newSchedule?.scheduleId,
				resourceName: newSchedule?.name,
			});
			return newSchedule;
		}),

	update: protectedProcedure
		.input(updateScheduleSchema)
		.mutation(async ({ input, ctx }) => {
			const existingSchedule = await findScheduleById(input.scheduleId);

			if (
				IS_CLOUD &&
				input.scheduleType &&
				input.scheduleType !== existingSchedule.scheduleType
			) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Changing scheduleType is not allowed in the cloud version.",
				});
			}

			await assertHostScheduleAccess(
				ctx,
				existingSchedule.scheduleType,
				existingSchedule.serverId,
			);
			if (
				input.scheduleType &&
				input.scheduleType !== existingSchedule.scheduleType
			) {
				await assertHostScheduleAccess(
					ctx,
					input.scheduleType,
					input.serverId ?? existingSchedule.serverId,
				);
			}

			const serviceId =
				existingSchedule.applicationId || existingSchedule.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					schedule: ["update"],
				});
			} else {
				await checkPermission(ctx, { schedule: ["update"] });
			}
			const updatedSchedule = await updateSchedule(input);

			if (IS_CLOUD) {
				if (updatedSchedule?.enabled) {
					schedule({
						scheduleId: updatedSchedule.scheduleId,
						type: "schedule",
						cronSchedule: updatedSchedule.cronExpression,
						timezone: updatedSchedule.timezone,
					});
				} else {
					await removeJob({
						cronSchedule: updatedSchedule.cronExpression,
						scheduleId: updatedSchedule.scheduleId,
						type: "schedule",
					});
				}
			} else {
				if (updatedSchedule?.enabled) {
					removeScheduleJob(updatedSchedule.scheduleId);
					scheduleJob(updatedSchedule);
				} else {
					removeScheduleJob(updatedSchedule.scheduleId);
				}
			}
			await audit(ctx, {
				action: "update",
				resourceType: "schedule",
				resourceId: updatedSchedule.scheduleId,
				resourceName: updatedSchedule.name,
			});
			return updatedSchedule;
		}),

	delete: protectedProcedure
		.input(z.object({ scheduleId: z.string() }))
		.mutation(async ({ input, ctx }) => {
			const scheduleItem = await findScheduleById(input.scheduleId);
			await assertHostScheduleAccess(
				ctx,
				scheduleItem.scheduleType,
				scheduleItem.serverId,
			);

			const serviceId = scheduleItem.applicationId || scheduleItem.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					schedule: ["delete"],
				});
			} else {
				await checkPermission(ctx, { schedule: ["delete"] });
			}
			await deleteSchedule(input.scheduleId);

			if (IS_CLOUD) {
				await removeJob({
					cronSchedule: scheduleItem.cronExpression,
					scheduleId: scheduleItem.scheduleId,
					type: "schedule",
				});
			} else {
				removeScheduleJob(scheduleItem.scheduleId);
			}
			await audit(ctx, {
				action: "delete",
				resourceType: "schedule",
				resourceId: scheduleItem.scheduleId,
				resourceName: scheduleItem.name,
			});
			return true;
		}),

	list: protectedProcedure
		.input(
			z.object({
				id: z.string(),
				scheduleType: z.enum([
					"application",
					"compose",
					"server",
					"dokploy-server",
				]),
			}),
		)
		.query(async ({ input, ctx }) => {
			if (
				input.scheduleType === "application" ||
				input.scheduleType === "compose"
			) {
				await checkServicePermissionAndAccess(ctx, input.id, {
					schedule: ["read"],
				});
			} else {
				await checkPermission(ctx, { schedule: ["read"] });

				if (input.scheduleType === "server") {
					const targetServer = await findServerById(input.id);
					if (
						targetServer.organizationId !== ctx.session.activeOrganizationId
					) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You don't have access to this server.",
						});
					}
				}

				if (input.scheduleType === "dokploy-server") {
					const member = await findMemberByUserId(
						ctx.user.id,
						ctx.session.activeOrganizationId,
					);
					if (member.role !== "owner" && member.role !== "admin") {
						throw new TRPCError({
							code: "FORBIDDEN",
							message: "Only owners and admins can list host-level schedules.",
						});
					}
				}
			}
			const where = {
				application: eq(schedules.applicationId, input.id),
				compose: eq(schedules.composeId, input.id),
				server: eq(schedules.serverId, input.id),
				"dokploy-server": eq(
					schedules.organizationId,
					ctx.session.activeOrganizationId,
				),
			};
			return db.query.schedules.findMany({
				where: where[input.scheduleType],
				orderBy: [asc(schedules.createdAt)],
				with: {
					application: {
						columns: {
							applicationId: true,
							appName: true,
							name: true,
							serverId: true,
						},
					},
					server: true,
					compose: {
						columns: {
							composeId: true,
							appName: true,
							name: true,
							serverId: true,
						},
					},
					deployments: {
						orderBy: [desc(deployments.createdAt)],
					},
				},
			});
		}),

	/**
	 * Every schedule in the active organization, whatever it is attached to.
	 *
	 * `list` answers "what is scheduled on this one thing", which means
	 * application and compose schedules are only ever visible inside their own
	 * service tab. This answers "what is scheduled anywhere", so the automation
	 * hub can show cron across every project on one screen. Host-level schedules
	 * stay owner/admin-only, matching the gate `list` applies to them.
	 */
	allForOrganization: protectedProcedure.query(async ({ ctx }) => {
		await checkPermission(ctx, { schedule: ["read"] });

		const organizationId = ctx.session.activeOrganizationId;
		const member = await findMemberByUserId(ctx.user.id, organizationId);
		const canSeeHostSchedules =
			member.role === "owner" || member.role === "admin";

		const rows = await db.query.schedules.findMany({
			orderBy: [asc(schedules.name)],
			with: {
				application: {
					columns: {
						applicationId: true,
						appName: true,
						name: true,
						serverId: true,
						environmentId: true,
					},
					with: {
						environment: {
							columns: { environmentId: true, name: true },
							with: {
								project: {
									columns: {
										projectId: true,
										name: true,
										organizationId: true,
									},
								},
							},
						},
					},
				},
				compose: {
					columns: {
						composeId: true,
						appName: true,
						name: true,
						serverId: true,
						environmentId: true,
					},
					with: {
						environment: {
							columns: { environmentId: true, name: true },
							with: {
								project: {
									columns: {
										projectId: true,
										name: true,
										organizationId: true,
									},
								},
							},
						},
					},
				},
				server: {
					columns: { serverId: true, name: true, organizationId: true },
				},
				deployments: {
					orderBy: [desc(deployments.createdAt)],
					limit: 1,
				},
			},
		});

		// findMany cannot express "belongs to my organization" across four
		// different parents, so scope in memory. Every branch must resolve to the
		// active organization or the row is dropped rather than leaked.
		return rows
			.filter((row) => {
				if (row.applicationId) {
					return (
						row.application?.environment?.project?.organizationId ===
						organizationId
					);
				}
				if (row.composeId) {
					return (
						row.compose?.environment?.project?.organizationId === organizationId
					);
				}
				if (row.serverId) {
					return row.server?.organizationId === organizationId;
				}
				return canSeeHostSchedules && row.organizationId === organizationId;
			})
			.map((row) => {
				const service = row.application ?? row.compose ?? null;
				const project = service?.environment?.project ?? null;
				const lastDeployment = row.deployments?.[0] ?? null;

				return {
					...row,
					target: {
						projectId: project?.projectId ?? null,
						projectName: project?.name ?? null,
						environmentId: service?.environmentId ?? null,
						environmentName: service?.environment?.name ?? null,
						serviceId:
							row.application?.applicationId ?? row.compose?.composeId ?? null,
						serviceName: service?.name ?? null,
						serverId: row.serverId ?? service?.serverId ?? null,
						serverName: row.server?.name ?? null,
					},
					lastRun: lastDeployment
						? {
								status: lastDeployment.status,
								createdAt: lastDeployment.createdAt,
								logPath: lastDeployment.logPath,
							}
						: null,
				};
			});
	}),

	one: protectedProcedure
		.input(z.object({ scheduleId: z.string() }))
		.query(async ({ input, ctx }) => {
			const schedule = await findScheduleById(input.scheduleId);
			const serviceId = schedule.applicationId || schedule.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					schedule: ["read"],
				});
			} else {
				await checkPermission(ctx, { schedule: ["read"] });

				if (schedule.scheduleType === "server" && schedule.serverId) {
					const targetServer = await findServerById(schedule.serverId);
					if (
						targetServer.organizationId !== ctx.session.activeOrganizationId
					) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You don't have access to this schedule.",
						});
					}
				}
			}
			return schedule;
		}),

	runManually: protectedProcedure
		.input(z.object({ scheduleId: z.string().min(1) }))
		.mutation(async ({ input, ctx }) => {
			const scheduleItem = await findScheduleById(input.scheduleId);
			await assertHostScheduleAccess(
				ctx,
				scheduleItem.scheduleType,
				scheduleItem.serverId,
			);

			const serviceId = scheduleItem.applicationId || scheduleItem.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					schedule: ["create"],
				});
			} else {
				await checkPermission(ctx, { schedule: ["create"] });
			}
			try {
				const deployment = await runCommand(input.scheduleId);
				await audit(ctx, {
					action: "run",
					resourceType: "schedule",
					resourceId: input.scheduleId,
				});
				return {
					status: deployment.status,
					deploymentId: deployment.deploymentId,
					logPath: deployment.logPath,
				};
			} catch (error) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message:
						error instanceof Error ? error.message : "Error running schedule",
				});
			}
		}),
});
