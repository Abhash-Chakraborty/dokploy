import { db } from "@dokploy/server/db";
import {
	abhashAnsibleProject,
	abhashAnsibleTemplate,
} from "@dokploy/server/db/schema";
import { enqueueJobForActor } from "@dokploy/server/services/abhash/agents";
import {
	ensureStarterProject,
	findTemplate,
	listProjects,
	listTemplates,
	resolveTargets,
	updateTemplateSchedule,
} from "@dokploy/server/services/abhash/ansible";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { adminProcedure, createTRPCRouter } from "../../trpc";

const asTrpc = (error: unknown) =>
	new TRPCError({
		code: "BAD_REQUEST",
		message: error instanceof Error ? error.message : String(error),
	});

const filePath = z
	.string()
	.trim()
	.min(1)
	.max(200)
	.regex(/^[\w./-]+$/, "Letters, numbers, dots, dashes and slashes only")
	.refine((value) => !value.includes("..") && !value.startsWith("/"), {
		message: "Paths stay inside the project",
	});

const templateFields = {
	name: z.string().trim().min(1).max(60),
	projectId: z.string(),
	playbook: filePath,
	targets: z.object({
		serverIds: z.array(z.string()).default([]),
		all: z.boolean().default(false),
	}),
	extraVars: z.record(z.string(), z.string()).default({}),
	checkMode: z.boolean().default(true),
	become: z.boolean().default(true),
	forks: z.number().int().min(1).max(50).default(5),
	limitPattern: z.string().trim().max(200).nullable().default(null),
	tags: z.array(z.string().trim().min(1).max(40)).default([]),
	cronExpression: z.string().trim().max(120).nullable().default(null),
	timezone: z.string().trim().max(60).default("UTC"),
	enabled: z.boolean().default(true),
};

export const abhashAnsibleRouter = createTRPCRouter({
	projects: adminProcedure.query(async ({ ctx }) => {
		await ensureStarterProject(ctx.session.activeOrganizationId, ctx.user.id);
		return listProjects(ctx.session.activeOrganizationId);
	}),

	saveProject: adminProcedure
		.input(
			z.object({
				id: z.string().optional(),
				name: z.string().trim().min(1).max(60),
				description: z.string().trim().max(300).default(""),
				files: z.record(filePath, z.string().max(200_000)),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const values = {
				name: input.name,
				description: input.description,
				files: input.files,
				updatedAt: new Date(),
			};
			const [row] = input.id
				? await db
						.update(abhashAnsibleProject)
						.set(values)
						.where(
							and(
								eq(abhashAnsibleProject.id, input.id),
								eq(abhashAnsibleProject.organizationId, organizationId),
							),
						)
						.returning()
				: await db
						.insert(abhashAnsibleProject)
						.values({ ...values, organizationId, createdBy: ctx.user.id })
						.returning();
			if (!row) throw new TRPCError({ code: "NOT_FOUND" });
			await audit(ctx, {
				action: input.id ? "update" : "create",
				resourceType: "schedule",
				resourceId: row.id,
				resourceName: `ansible project ${row.name}`,
			});
			return row;
		}),

	removeProject: adminProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			await db
				.delete(abhashAnsibleProject)
				.where(
					and(
						eq(abhashAnsibleProject.id, input.id),
						eq(
							abhashAnsibleProject.organizationId,
							ctx.session.activeOrganizationId,
						),
					),
				);
			await audit(ctx, {
				action: "delete",
				resourceType: "schedule",
				resourceId: input.id,
				resourceName: "ansible project",
			});
			return true;
		}),

	templates: adminProcedure.query(({ ctx }) =>
		listTemplates(ctx.session.activeOrganizationId),
	),

	saveTemplate: adminProcedure
		.input(z.object({ id: z.string().optional(), ...templateFields }))
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const { id, ...values } = input;
			const [row] = id
				? await db
						.update(abhashAnsibleTemplate)
						.set({ ...values, updatedAt: new Date() })
						.where(
							and(
								eq(abhashAnsibleTemplate.id, id),
								eq(abhashAnsibleTemplate.organizationId, organizationId),
							),
						)
						.returning()
				: await db
						.insert(abhashAnsibleTemplate)
						.values({ ...values, organizationId, createdBy: ctx.user.id })
						.returning();
			if (!row) throw new TRPCError({ code: "NOT_FOUND" });
			await updateTemplateSchedule(organizationId, row.id).catch(() => false);
			await audit(ctx, {
				action: id ? "update" : "create",
				resourceType: "schedule",
				resourceId: row.id,
				resourceName: `ansible ${row.name}`,
			});
			return row;
		}),

	removeTemplate: adminProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			await db
				.delete(abhashAnsibleTemplate)
				.where(
					and(
						eq(abhashAnsibleTemplate.id, input.id),
						eq(
							abhashAnsibleTemplate.organizationId,
							ctx.session.activeOrganizationId,
						),
					),
				);
			await audit(ctx, {
				action: "delete",
				resourceType: "schedule",
				resourceId: input.id,
				resourceName: "ansible run",
			});
			return true;
		}),

	/** What this run would touch, before anyone starts it. */
	preview: adminProcedure
		.input(z.object({ id: z.string() }))
		.query(async ({ ctx, input }) => {
			try {
				const { template, project } = await findTemplate(
					ctx.session.activeOrganizationId,
					input.id,
				);
				const hosts = await resolveTargets(
					ctx.session.activeOrganizationId,
					template.targets,
				);
				return {
					playbook: project.files[template.playbook] ?? null,
					hosts: hosts.map((host) => ({
						name: host.name,
						address: host.address,
					})),
				};
			} catch (error) {
				throw asTrpc(error);
			}
		}),

	run: adminProcedure
		.input(
			z.object({
				id: z.string(),
				checkMode: z.boolean().default(true),
				limit: z.string().trim().max(200).nullable().default(null),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				const queued = await enqueueJobForActor(
					"ansible.run",
					{
						organizationId: ctx.session.activeOrganizationId,
						templateId: input.id,
						checkMode: input.checkMode,
						limit: input.limit,
					},
					{
						actor: ctx.actor ?? {
							type: "user",
							id: ctx.user.id,
							name: ctx.user.email,
						},
						organizationId: ctx.session.activeOrganizationId,
					},
				);
				await audit(ctx, {
					action: "run",
					resourceType: "schedule",
					resourceId: input.id,
					resourceName: input.checkMode ? "ansible check" : "ansible apply",
					metadata: { approval: !!queued.approval },
				});
				return {
					jobId: queued.job?.id ?? null,
					approvalId: queued.approval?.id ?? null,
				};
			} catch (error) {
				throw asTrpc(error);
			}
		}),
});
