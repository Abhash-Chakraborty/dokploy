import { db } from "@dokploy/server/db";
import {
	abhashFirewallPolicy,
	abhashFirewallRule,
	abhashServerFirewall,
	server,
} from "@dokploy/server/db/schema";
import { enqueueJobForActor } from "@dokploy/server/services/abhash/agents";
import {
	checkDrift,
	ensureFirewallRow,
	planFirewall,
} from "@dokploy/server/services/abhash/firewall";
import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { adminProcedure, createTRPCRouter } from "../../trpc";

const asTrpc = (error: unknown) =>
	new TRPCError({
		code: "BAD_REQUEST",
		message: error instanceof Error ? error.message : String(error),
	});

const sourceInput = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("any") }),
	z.object({
		kind: z.literal("cidr"),
		value: z.string().trim().min(7).max(43),
	}),
	z.object({ kind: z.literal("mesh") }),
	z.object({ kind: z.literal("control") }),
	z.object({ kind: z.literal("group"), groupId: z.string() }),
]);

const ownServer = async (organizationId: string, serverId: string) => {
	const row = await db.query.server.findFirst({
		where: and(
			eq(server.serverId, serverId),
			eq(server.organizationId, organizationId),
		),
		columns: { serverId: true, name: true },
	});
	if (!row)
		throw new TRPCError({ code: "NOT_FOUND", message: "Server not found" });
	return row;
};

export const abhashFirewallRouter = createTRPCRouter({
	list: adminProcedure.query(async ({ ctx }) => {
		const organizationId = ctx.session.activeOrganizationId;
		const servers = await db.query.server.findMany({
			where: eq(server.organizationId, organizationId),
			orderBy: [asc(server.name)],
			columns: { serverId: true, name: true, ipAddress: true },
		});
		const settings = await db.query.abhashServerFirewall.findMany({
			where: eq(abhashServerFirewall.organizationId, organizationId),
		});
		const policies = await db.query.abhashFirewallPolicy.findMany({
			where: eq(abhashFirewallPolicy.organizationId, organizationId),
			orderBy: [asc(abhashFirewallPolicy.name)],
		});
		const rules = await db.query.abhashFirewallRule.findMany({
			where: eq(abhashFirewallRule.organizationId, organizationId),
			orderBy: [asc(abhashFirewallRule.priority)],
		});
		const byServer = new Map(settings.map((row) => [row.serverId, row]));
		return {
			policies,
			rules,
			servers: servers.map((row) => ({
				...row,
				firewall: byServer.get(row.serverId) ?? null,
			})),
		};
	}),

	/** The exact rules that would be applied, and why each one is there. */
	plan: adminProcedure
		.input(z.object({ serverId: z.string() }))
		.query(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			await ownServer(organizationId, input.serverId);
			try {
				const plan = await planFirewall(input.serverId, organizationId);
				return {
					mode: plan.mode,
					lockout: plan.lockout,
					hash: plan.rendered.hash,
					rules: plan.rules,
					ufw: plan.rendered.ufw,
					dockerBlock: plan.rendered.dockerBlock,
				};
			} catch (error) {
				throw asTrpc(error);
			}
		}),

	setMode: adminProcedure
		.input(
			z.object({
				serverId: z.string(),
				mode: z.enum(["off", "audit", "enforce"]),
				policyIds: z.array(z.string()).optional(),
				disabledAutoRules: z.array(z.string()).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const target = await ownServer(organizationId, input.serverId);
			await ensureFirewallRow(input.serverId, organizationId);
			const { serverId, ...values } = input;
			await db
				.update(abhashServerFirewall)
				.set({ ...values, updatedAt: new Date() })
				.where(eq(abhashServerFirewall.serverId, serverId));
			await audit(ctx, {
				action: "update",
				resourceType: "security",
				resourceId: serverId,
				resourceName: `firewall ${target.name}`,
				metadata: values,
			});
			return true;
		}),

	apply: adminProcedure
		.input(z.object({ serverIds: z.array(z.string()).min(1) }))
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			for (const id of input.serverIds) await ownServer(organizationId, id);
			try {
				const queued = await enqueueJobForActor(
					"firewall.apply",
					{ organizationId, serverIds: input.serverIds },
					{
						actor: ctx.actor ?? {
							type: "user",
							id: ctx.user.id,
							name: ctx.user.email,
						},
						organizationId,
					},
				);
				await audit(ctx, {
					action: "run",
					resourceType: "security",
					resourceName: "firewall apply",
					metadata: {
						servers: input.serverIds.length,
						approval: !!queued.approval,
					},
				});
				return {
					jobId: queued.job?.id ?? null,
					approvalId: queued.approval?.id ?? null,
				};
			} catch (error) {
				throw asTrpc(error);
			}
		}),

	drift: adminProcedure
		.input(z.object({ serverId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			await ownServer(organizationId, input.serverId);
			try {
				return await checkDrift(input.serverId, organizationId);
			} catch (error) {
				throw asTrpc(error);
			}
		}),

	saveRule: adminProcedure
		.input(
			z.object({
				id: z.string().optional(),
				policyId: z.string().nullable().default(null),
				serverId: z.string().nullable().default(null),
				chain: z.enum(["input", "docker"]).default("input"),
				action: z.enum(["allow", "deny", "limit", "reject"]).default("allow"),
				protocol: z.enum(["tcp", "udp"]).default("tcp"),
				port: z
					.string()
					.trim()
					.regex(/^\d{1,5}(:\d{1,5})?$/, "A port or a range like 8000:8010"),
				source: sourceInput,
				comment: z.string().trim().max(120).default(""),
				priority: z.number().int().min(0).max(1000).default(100),
				enabled: z.boolean().default(true),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			if (input.serverId) await ownServer(organizationId, input.serverId);
			const { id, ...values } = input;
			const [row] = id
				? await db
						.update(abhashFirewallRule)
						.set(values)
						.where(
							and(
								eq(abhashFirewallRule.id, id),
								eq(abhashFirewallRule.organizationId, organizationId),
							),
						)
						.returning()
				: await db
						.insert(abhashFirewallRule)
						.values({ ...values, organizationId })
						.returning();
			if (!row) throw new TRPCError({ code: "NOT_FOUND" });
			await audit(ctx, {
				action: id ? "update" : "create",
				resourceType: "security",
				resourceId: row.id,
				resourceName: `firewall rule ${row.port}/${row.protocol}`,
				metadata: values,
			});
			return row;
		}),

	removeRule: adminProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			await db
				.delete(abhashFirewallRule)
				.where(
					and(
						eq(abhashFirewallRule.id, input.id),
						eq(
							abhashFirewallRule.organizationId,
							ctx.session.activeOrganizationId,
						),
					),
				);
			await audit(ctx, {
				action: "delete",
				resourceType: "security",
				resourceId: input.id,
				resourceName: "firewall rule",
			});
			return true;
		}),

	savePolicy: adminProcedure
		.input(
			z.object({
				id: z.string().optional(),
				name: z.string().trim().min(1).max(60),
				description: z.string().trim().max(300).default(""),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const { id, ...values } = input;
			const [row] = id
				? await db
						.update(abhashFirewallPolicy)
						.set(values)
						.where(
							and(
								eq(abhashFirewallPolicy.id, id),
								eq(abhashFirewallPolicy.organizationId, organizationId),
							),
						)
						.returning()
				: await db
						.insert(abhashFirewallPolicy)
						.values({ ...values, organizationId })
						.returning();
			if (!row) throw new TRPCError({ code: "NOT_FOUND" });
			return row;
		}),
});
