import { randomBytes } from "node:crypto";
import { db } from "@dokploy/server/db";
import { abhashServerFirewall } from "@dokploy/server/db/schema";
import { enqueueJobForActor } from "@dokploy/server/services/abhash/agents";
import {
	ensureFirewallRow,
	planFirewall,
} from "@dokploy/server/services/abhash/firewall/apply";
import {
	confirmSshScript,
	createUserScript,
	deleteUserScript,
	disableRescueScript,
	enableRescueScript,
	HOST_COMMANDS,
	hostCommandScript,
	listUsersScript,
	lockUserScript,
	parseRescueStatus,
	parseUsers,
	RESCUE_USER,
	rescueStatusScript,
	rotateRescuePasswordScript,
	setKeysScript,
	validatePublicKeys,
	validateRescuePort,
	validateUsername,
} from "@dokploy/server/services/abhash/host-access/scripts";
import { getLocalSsh } from "@dokploy/server/services/abhash/local-terminal";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	type HostResult,
	runOnHost,
	scriptError,
} from "@/server/utils/host-exec";
import { adminProcedure, createTRPCRouter } from "../../trpc";

const serverInput = z.object({ serverId: z.string().min(1) });

// Auto rules the exposure levels switch; see firewall/compile.ts.
const WEB_RULES = ["web", "web-tls"];

/** "local" or one of this organization's servers. */
const targetFor = async (organizationId: string, serverId: string) => {
	if (serverId === "local") {
		const saved = await getLocalSsh();
		return { name: "Dokploy host", loginUser: saved?.username ?? null };
	}
	const row = await db.query.server.findFirst({
		where: (fields, { eq: equals }) =>
			and(
				equals(fields.serverId, serverId),
				equals(fields.organizationId, organizationId),
			),
		columns: { name: true, username: true },
	});
	if (!row)
		throw new TRPCError({ code: "NOT_FOUND", message: "Server not found" });
	return { name: row.name, loginUser: row.username };
};

const run = async (serverId: string, script: string, fresh = false) => {
	let result: HostResult;
	try {
		result = await runOnHost(serverId, script, { fresh });
	} catch (error) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: error instanceof Error ? error.message : String(error),
		});
	}
	if (result.code !== 0) {
		throw new TRPCError({ code: "BAD_REQUEST", message: scriptError(result) });
	}
	return result;
};

/** Restarted sshd: log in afresh to prove it works, which also cancels the revert timer. */
const confirmSsh = async (serverId: string) => {
	await new Promise((resolve) => setTimeout(resolve, 3000));
	try {
		await run(serverId, confirmSshScript(), true);
	} catch {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Dokploy could not log in again after the SSH change, so the server will put the old settings back within three minutes.",
		});
	}
};

const generatePassword = () =>
	randomBytes(18).toString("base64").replace(/[+/=]/g, "").slice(0, 20);

export const abhashHostAccessRouter = createTRPCRouter({
	users: adminProcedure.input(serverInput).query(async ({ ctx, input }) => {
		const target = await targetFor(
			ctx.session.activeOrganizationId,
			input.serverId,
		);
		const result = await run(input.serverId, listUsersScript());
		return {
			loginUser: target.loginUser,
			users: parseUsers(result.stdout),
		};
	}),

	createUser: adminProcedure
		.input(
			serverInput.extend({
				name: z.string().trim(),
				publicKeys: z.string().min(1),
				sudo: z.enum(["none", "password", "nopasswd"]),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const target = await targetFor(
				ctx.session.activeOrganizationId,
				input.serverId,
			);
			const name = validateUsername(input.name);
			if (name === RESCUE_USER) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Use the Rescue tab for the rescue login",
				});
			}
			const keys = validatePublicKeys(input.publicKeys);
			await run(
				input.serverId,
				createUserScript({ name, publicKeys: keys, sudo: input.sudo }),
			);
			await audit(ctx, {
				action: "create",
				resourceType: "security",
				resourceName: `${target.name}: user ${name}`,
				metadata: { sudo: input.sudo, keys: keys.length },
			});
			return true;
		}),

	setKeys: adminProcedure
		.input(serverInput.extend({ name: z.string(), publicKeys: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const target = await targetFor(
				ctx.session.activeOrganizationId,
				input.serverId,
			);
			const keys = validatePublicKeys(input.publicKeys);
			if (input.name === target.loginUser && keys.length === 0) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Dokploy logs in as ${input.name}; removing every key would lock it out`,
				});
			}
			await run(input.serverId, setKeysScript(input.name, keys));
			await audit(ctx, {
				action: "update",
				resourceType: "security",
				resourceName: `${target.name}: keys of ${input.name}`,
				metadata: { keys: keys.length },
			});
			return true;
		}),

	lockUser: adminProcedure
		.input(serverInput.extend({ name: z.string(), locked: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			const target = await targetFor(
				ctx.session.activeOrganizationId,
				input.serverId,
			);
			if (
				input.locked &&
				(input.name === "root" || input.name === target.loginUser)
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Locking ${input.name} would cut Dokploy off from this server`,
				});
			}
			await run(input.serverId, lockUserScript(input.name, input.locked));
			await audit(ctx, {
				action: "update",
				resourceType: "security",
				resourceName: `${target.name}: ${input.locked ? "locked" : "unlocked"} ${input.name}`,
			});
			return true;
		}),

	deleteUser: adminProcedure
		.input(
			serverInput.extend({
				name: z.string(),
				removeHome: z.boolean().default(false),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const target = await targetFor(
				ctx.session.activeOrganizationId,
				input.serverId,
			);
			if (input.name === "root" || input.name === target.loginUser) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `${input.name} cannot be deleted: Dokploy needs it to reach this server`,
				});
			}
			await run(input.serverId, deleteUserScript(input.name, input.removeHome));
			await audit(ctx, {
				action: "delete",
				resourceType: "security",
				resourceName: `${target.name}: user ${input.name}`,
				metadata: { removeHome: input.removeHome },
			});
			return true;
		}),

	rescue: adminProcedure.input(serverInput).query(async ({ ctx, input }) => {
		await targetFor(ctx.session.activeOrganizationId, input.serverId);
		const result = await run(input.serverId, rescueStatusScript());
		return parseRescueStatus(result.stdout);
	}),

	enableRescue: adminProcedure
		.input(
			serverInput.extend({
				port: z.number().int(),
				password: z.string().min(12).max(128).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const target = await targetFor(
				ctx.session.activeOrganizationId,
				input.serverId,
			);
			const status = parseRescueStatus(
				(await run(input.serverId, rescueStatusScript())).stdout,
			);
			if (status.port && !status.managed) {
				throw new TRPCError({
					code: "CONFLICT",
					message: `A rescue login set up outside Dokploy already uses port ${status.port}; only its password can be changed here`,
				});
			}
			const port = validateRescuePort(
				input.port,
				status.sshPorts.filter((entry) => entry !== status.port),
			);
			const password = input.password ?? generatePassword();
			await run(
				input.serverId,
				enableRescueScript({
					port,
					password,
					sshPorts: status.sshPorts.filter((entry) => entry !== status.port),
				}),
			);
			await confirmSsh(input.serverId);
			await audit(ctx, {
				action: "update",
				resourceType: "security",
				resourceName: `${target.name}: rescue login on port ${port}`,
			});
			// Shown once; Dokploy does not store it.
			return { password, port };
		}),

	rotateRescue: adminProcedure
		.input(
			serverInput.extend({ password: z.string().min(12).max(128).optional() }),
		)
		.mutation(async ({ ctx, input }) => {
			const target = await targetFor(
				ctx.session.activeOrganizationId,
				input.serverId,
			);
			const password = input.password ?? generatePassword();
			await run(input.serverId, rotateRescuePasswordScript(password));
			await audit(ctx, {
				action: "update",
				resourceType: "security",
				resourceName: `${target.name}: rescue password rotated`,
			});
			return { password };
		}),

	disableRescue: adminProcedure
		.input(serverInput)
		.mutation(async ({ ctx, input }) => {
			const target = await targetFor(
				ctx.session.activeOrganizationId,
				input.serverId,
			);
			const status = parseRescueStatus(
				(await run(input.serverId, rescueStatusScript())).stdout,
			);
			if (!status.managed) {
				throw new TRPCError({
					code: "CONFLICT",
					message:
						"This rescue login was set up outside Dokploy; remove it where it was made",
				});
			}
			await run(input.serverId, disableRescueScript(status.port));
			await confirmSsh(input.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "security",
				resourceName: `${target.name}: rescue login removed`,
			});
			return true;
		}),

	commands: adminProcedure.query(() =>
		HOST_COMMANDS.map(({ script: _script, ...command }) => command),
	),

	runCommand: adminProcedure
		.input(serverInput.extend({ commandId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const target = await targetFor(
				ctx.session.activeOrganizationId,
				input.serverId,
			);
			const command = HOST_COMMANDS.find(
				(entry) => entry.id === input.commandId,
			);
			if (!command)
				throw new TRPCError({ code: "NOT_FOUND", message: "Unknown command" });
			let result: HostResult;
			try {
				result = await runOnHost(
					input.serverId,
					hostCommandScript(command.id),
					{
						timeoutMs: 300_000,
					},
				);
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error instanceof Error ? error.message : String(error),
				});
			}
			if (command.risk !== "read") {
				await audit(ctx, {
					action: "run",
					resourceType: "security",
					resourceName: `${target.name}: ${command.label}`,
					metadata: { exitCode: result.code },
				});
			}
			return {
				code: result.code,
				output:
					`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim(),
			};
		}),

	exposure: adminProcedure.input(serverInput).query(async ({ ctx, input }) => {
		if (input.serverId === "local") return null;
		await targetFor(ctx.session.activeOrganizationId, input.serverId);
		const row = await db.query.abhashServerFirewall.findFirst({
			where: eq(abhashServerFirewall.serverId, input.serverId),
		});
		const plan = await planFirewall(
			input.serverId,
			ctx.session.activeOrganizationId,
		);
		const hasMesh = plan.rules.some((rule) => rule.origin === "auto:mesh");
		const level =
			!row || row.mode === "off"
				? "open"
				: WEB_RULES.every((rule) => row.disabledAutoRules.includes(rule))
					? "private"
					: "web";
		return {
			level,
			mode: row?.mode ?? "off",
			hasMesh,
			appliedAt: row?.appliedAt ?? null,
			lastError: row?.lastError ?? null,
		};
	}),

	setExposure: adminProcedure
		.input(serverInput.extend({ level: z.enum(["open", "web", "private"]) }))
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			if (input.serverId === "local") {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "The Dokploy host's own firewall is not managed from here",
				});
			}
			const target = await targetFor(organizationId, input.serverId);
			await ensureFirewallRow(input.serverId, organizationId);
			const row = await db.query.abhashServerFirewall.findFirst({
				where: eq(abhashServerFirewall.serverId, input.serverId),
			});
			const others = (row?.disabledAutoRules ?? []).filter(
				(rule) => !WEB_RULES.includes(rule),
			);
			const previous = {
				mode: row?.mode ?? "off",
				disabledAutoRules: row?.disabledAutoRules ?? [],
			};
			await db
				.update(abhashServerFirewall)
				.set({
					mode: input.level === "open" ? "off" : "enforce",
					disabledAutoRules:
						input.level === "private" ? [...others, ...WEB_RULES] : others,
					updatedAt: new Date(),
				})
				.where(eq(abhashServerFirewall.serverId, input.serverId));

			if (input.level !== "open") {
				const plan = await planFirewall(input.serverId, organizationId);
				const hasMesh = plan.rules.some((rule) => rule.origin === "auto:mesh");
				const problem =
					plan.lockout ??
					(input.level === "private" && !hasMesh
						? "Private needs the server on the secure network first; otherwise SSH would stay open to the internet."
						: null);
				if (problem) {
					await db
						.update(abhashServerFirewall)
						.set({ ...previous, updatedAt: new Date() })
						.where(eq(abhashServerFirewall.serverId, input.serverId));
					throw new TRPCError({ code: "BAD_REQUEST", message: problem });
				}
			}

			if (input.level === "open") {
				await audit(ctx, {
					action: "update",
					resourceType: "security",
					resourceId: input.serverId,
					resourceName: `${target.name}: exposure open`,
				});
				return { jobId: null, approvalId: null };
			}

			const queued = await enqueueJobForActor(
				"firewall.apply",
				{ organizationId, serverIds: [input.serverId] },
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
				action: "update",
				resourceType: "security",
				resourceId: input.serverId,
				resourceName: `${target.name}: exposure ${input.level}`,
				metadata: { approval: !!queued.approval },
			});
			return {
				jobId: queued.job?.id ?? null,
				approvalId: queued.approval?.id ?? null,
			};
		}),
});
