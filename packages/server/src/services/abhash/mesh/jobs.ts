import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../db";
import { abhashServerMesh, abhashServerMeta, server } from "../../../db/schema";
import { defineJob } from "../jobs/registry";
import { closeConnection, execPooled } from "../ssh/pool";
import {
	activeProvider,
	clientFor,
	meshName,
	serverMesh,
	syncPeers,
} from "./service";

const statusScript = {
	netbird: "netbird status --json 2>/dev/null || netbird status 2>/dev/null",
	headscale: "tailscale status --json 2>/dev/null",
} as const;

/** Reads the mesh address the client actually got, from the server itself. */
export const readMeshIp = (kind: "netbird" | "headscale", output: string) => {
	try {
		const parsed = JSON.parse(output) as Record<string, unknown>;
		if (kind === "netbird") {
			const ip = (parsed.netbirdIp ?? parsed.netbird_ip) as string | undefined;
			return ip ? ip.split("/")[0] : null;
		}
		const ips = (parsed.Self as { TailscaleIPs?: string[] } | undefined)
			?.TailscaleIPs;
		return ips?.[0] ?? null;
	} catch {
		const match = output.match(/(\d+\.\d+\.\d+\.\d+)/);
		return match?.[1] ?? null;
	}
};

const requireProvider = async (organizationId: string) => {
	const provider = await activeProvider(organizationId);
	if (!provider) {
		throw new Error("No mesh provider is active for this organization");
	}
	return provider;
};

export const meshJoinJob = defineJob({
	type: "mesh.join",
	queue: "abhash-infra",
	input: z.object({
		organizationId: z.string(),
		serverId: z.string(),
		/** Switch Dokploy's own connection to the mesh address afterwards. */
		useForSsh: z.boolean().default(true),
	}),
	title: () => "Join the secure network",
	destructive: true,
	timeoutMs: 20 * 60_000,
	lock: (input) => ({ key: `server:${input.serverId}`, limit: 1 }),
	run: async ({ input, log, redact }) => {
		const provider = await requireProvider(input.organizationId);
		const client = await clientFor(provider);
		const row = await db.query.server.findFirst({
			where: eq(server.serverId, input.serverId),
			columns: { name: true },
		});
		if (!row) throw new Error("Server not found");
		const hostname = meshName(row.name);

		await log(`Making sure the ${provider.kind} groups and policy exist…`);
		const plan = await client.ensurePolicy(false);
		for (const line of [...plan.create, ...plan.remove]) await log(`  ${line}`);

		const enrollment = await client.createEnrollmentKey(hostname);
		// The key would otherwise appear in the job log.
		redact(enrollment.key);
		await log("Installing and enrolling the client…");
		const joined = await execPooled(
			input.serverId,
			client.joinCommand(enrollment.key, hostname),
			{ timeoutMs: 10 * 60_000 },
		);
		if (joined.exitCode !== 0) {
			throw new Error(
				`Joining failed (exit ${joined.exitCode}): ${joined.stderr.slice(0, 400)}`,
			);
		}

		const status = await execPooled(
			input.serverId,
			statusScript[provider.kind],
			{ timeoutMs: 60_000 },
		);
		const meshIp = readMeshIp(provider.kind, status.stdout);
		if (!meshIp) throw new Error("The client joined but reported no address");
		await log(`Mesh address: ${meshIp}`);

		await db
			.insert(abhashServerMesh)
			.values({
				serverId: input.serverId,
				providerId: provider.id,
				meshIp,
				meshHostname: hostname,
				status: "connected",
				joinedAt: new Date(),
				lastSeenAt: new Date(),
			})
			.onConflictDoUpdate({
				target: abhashServerMesh.serverId,
				set: {
					providerId: provider.id,
					meshIp,
					meshHostname: hostname,
					status: "connected",
					joinedAt: new Date(),
					lastSeenAt: new Date(),
				},
			});
		await syncPeers(input.organizationId);

		if (input.useForSsh) {
			// Prove SSH works over the mesh before making it the way in, and
			// fall back to the public address if it does not.
			await db
				.update(abhashServerMeta)
				.set({ connectVia: "mesh", updatedAt: new Date() })
				.where(eq(abhashServerMeta.serverId, input.serverId));
			closeConnection(input.serverId);
			try {
				const check = await execPooled(input.serverId, "echo ok", {
					timeoutMs: 30_000,
				});
				if (check.stdout.trim() !== "ok") throw new Error("no reply");
				await log("SSH over the mesh works; using it from now on");
			} catch (error) {
				await db
					.update(abhashServerMeta)
					.set({ connectVia: "public", updatedAt: new Date() })
					.where(eq(abhashServerMeta.serverId, input.serverId));
				closeConnection(input.serverId);
				await log(
					`SSH over the mesh did not work (${error instanceof Error ? error.message : error}); keeping the public address`,
				);
			}
		}
		return { meshIp, hostname };
	},
});

export const meshLeaveJob = defineJob({
	type: "mesh.leave",
	queue: "abhash-infra",
	input: z.object({
		organizationId: z.string(),
		serverId: z.string(),
	}),
	title: () => "Leave the secure network",
	destructive: true,
	timeoutMs: 10 * 60_000,
	lock: (input) => ({ key: `server:${input.serverId}`, limit: 1 }),
	run: async ({ input, log }) => {
		const provider = await requireProvider(input.organizationId);
		const client = await clientFor(provider);
		const existing = await serverMesh(input.serverId);

		// Come back over the public address first, or the next step cuts the
		// connection it is running on.
		await db
			.update(abhashServerMeta)
			.set({ connectVia: "public", updatedAt: new Date() })
			.where(eq(abhashServerMeta.serverId, input.serverId));
		closeConnection(input.serverId);

		const left = await execPooled(input.serverId, client.leaveCommand(), {
			timeoutMs: 120_000,
		});
		await log(`Client stopped (exit ${left.exitCode})`);
		if (existing?.peerId) {
			await client.removePeer(existing.peerId).catch(async (error) => {
				await log(`Could not delete the peer: ${error}`);
			});
		}
		await db
			.delete(abhashServerMesh)
			.where(eq(abhashServerMesh.serverId, input.serverId));
		return { removed: !!existing?.peerId };
	},
});

export const meshSyncJob = defineJob({
	type: "mesh.sync",
	queue: "abhash-infra",
	input: z.object({ organizationId: z.string() }),
	title: () => "Sync the secure network",
	timeoutMs: 5 * 60_000,
	run: async ({ input, log }) => {
		const result = await syncPeers(input.organizationId);
		await log(`${result.matched} of ${result.peers} peers matched a server`);
		return result;
	},
});
