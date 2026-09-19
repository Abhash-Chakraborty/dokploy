import {
	createAgent,
	decideApproval,
	deleteAgent,
	findAgent,
	getApproval,
	issueAgentKey,
	listAgents,
	listApprovals,
	revokeAgentKey,
	setKeyPolicy,
	updateAgent,
} from "@dokploy/server/services/abhash/agents";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
} from "../../trpc";

const policyInput = z.object({
	readOnly: z.boolean().default(false),
	allow: z.array(z.string().trim().min(1).max(100)).default([]),
	ipAllowList: z.array(z.string().trim().min(1).max(64)).default([]),
	approvalMode: z.enum(["destructive", "all", "none"]).default("destructive"),
});

const asTrpc = (error: unknown) =>
	new TRPCError({
		code: "BAD_REQUEST",
		message: error instanceof Error ? error.message : String(error),
	});

export const abhashAgentsRouter = createTRPCRouter({
	list: adminProcedure.query(({ ctx }) =>
		listAgents(ctx.session.activeOrganizationId),
	),

	create: adminProcedure
		.input(
			z.object({
				name: z.string().trim().min(1).max(60),
				description: z.string().trim().max(300).default(""),
				role: z.enum(["member", "admin"]).default("member"),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				const agent = await createAgent({
					organizationId: ctx.session.activeOrganizationId,
					createdBy: ctx.user.id,
					...input,
				});
				await audit(ctx, {
					action: "create",
					resourceType: "agent",
					resourceId: agent.id,
					resourceName: agent.name,
					metadata: { role: input.role },
				});
				return agent;
			} catch (error) {
				throw asTrpc(error);
			}
		}),

	update: adminProcedure
		.input(
			z.object({
				id: z.string(),
				name: z.string().trim().min(1).max(60).optional(),
				description: z.string().trim().max(300).optional(),
				enabled: z.boolean().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { id, ...values } = input;
			try {
				const agent = await updateAgent(
					ctx.session.activeOrganizationId,
					id,
					values,
				);
				await audit(ctx, {
					action: "update",
					resourceType: "agent",
					resourceId: id,
					resourceName: agent.name,
					metadata: values,
				});
				return agent;
			} catch (error) {
				throw asTrpc(error);
			}
		}),

	remove: adminProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const agent = await findAgent(
				ctx.session.activeOrganizationId,
				input.id,
			).catch((error) => {
				throw asTrpc(error);
			});
			await deleteAgent(ctx.session.activeOrganizationId, input.id);
			await audit(ctx, {
				action: "delete",
				resourceType: "agent",
				resourceId: input.id,
				resourceName: agent.name,
			});
			return true;
		}),

	/** The key is shown once here and never stored in readable form. */
	createKey: adminProcedure
		.input(
			z.object({
				agentId: z.string(),
				name: z.string().trim().min(1).max(60),
				expiresInDays: z.number().int().min(1).max(3650).nullable().default(90),
				policy: policyInput,
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				const key = await issueAgentKey({
					organizationId: ctx.session.activeOrganizationId,
					agentId: input.agentId,
					name: input.name,
					expiresInDays: input.expiresInDays,
					policy: input.policy,
				});
				await audit(ctx, {
					action: "create",
					resourceType: "agent",
					resourceId: input.agentId,
					resourceName: input.name,
					metadata: { keyId: key.id, policy: input.policy },
				});
				return { id: key.id, key: key.key };
			} catch (error) {
				throw asTrpc(error);
			}
		}),

	setKeyPolicy: adminProcedure
		.input(z.object({ keyId: z.string(), policy: policyInput }))
		.mutation(async ({ ctx, input }) => {
			await setKeyPolicy(
				ctx.session.activeOrganizationId,
				input.keyId,
				input.policy,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "agent",
				resourceId: input.keyId,
				resourceName: "key policy",
				metadata: input.policy,
			});
			return true;
		}),

	revokeKey: adminProcedure
		.input(z.object({ agentId: z.string(), keyId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			try {
				await revokeAgentKey(
					ctx.session.activeOrganizationId,
					input.agentId,
					input.keyId,
				);
			} catch (error) {
				throw asTrpc(error);
			}
			await audit(ctx, {
				action: "delete",
				resourceType: "agent",
				resourceId: input.agentId,
				resourceName: "api key",
				metadata: { keyId: input.keyId },
			});
			return true;
		}),

	approvals: createTRPCRouter({
		list: adminProcedure
			.input(
				z.object({
					status: z
						.enum([
							"pending",
							"approved",
							"rejected",
							"expired",
							"executed",
							"failed",
						])
						.optional(),
				}),
			)
			.query(({ ctx, input }) =>
				listApprovals(ctx.session.activeOrganizationId, input.status),
			),

		/** Also used by the agent itself to poll its own request. */
		get: protectedProcedure
			.input(z.object({ id: z.string() }))
			.query(async ({ ctx, input }) => {
				const approval = await getApproval(
					ctx.session.activeOrganizationId,
					input.id,
				);
				if (!approval) {
					throw new TRPCError({ code: "NOT_FOUND", message: "Not found" });
				}
				const isRequester = approval.requester.id === ctx.actor?.id;
				const isAdmin = ctx.user.role === "owner" || ctx.user.role === "admin";
				if (!isRequester && !isAdmin) {
					throw new TRPCError({ code: "NOT_FOUND", message: "Not found" });
				}
				return approval;
			}),

		decide: adminProcedure
			.input(
				z.object({
					id: z.string(),
					approve: z.boolean(),
					reason: z.string().trim().max(300).optional(),
				}),
			)
			.mutation(async ({ ctx, input }) => {
				// An agent must never approve its own request.
				if (ctx.actor && ctx.actor.type !== "user") {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "Only a person can decide an approval",
					});
				}
				try {
					return await decideApproval({
						organizationId: ctx.session.activeOrganizationId,
						id: input.id,
						approve: input.approve,
						reason: input.reason,
						decidedBy: {
							id: ctx.user.id,
							email: ctx.user.email,
							role: ctx.user.role,
						},
					});
				} catch (error) {
					throw asTrpc(error);
				}
			}),
	}),
});
