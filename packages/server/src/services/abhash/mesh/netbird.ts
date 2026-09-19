import {
	type EnrollmentKey,
	MeshApiError,
	type MeshPeer,
	type MeshProvider,
	type PolicyPlan,
	type ProviderContext,
	request,
} from "./types";

type NbPeer = {
	id: string;
	name: string;
	ip: string;
	dns_label?: string;
	connected: boolean;
	last_seen?: string;
	version?: string;
	os?: string;
	approval_required?: boolean;
};

type NbGroup = { id: string; name: string; peers_count?: number };

type NbPolicy = { id: string; name: string; enabled: boolean };

const SWARM_PORTS = {
	tcp: [2377, 7946],
	udp: [7946, 4789],
};

/**
 * NetBird, self-hosted. Dokploy only ever creates or updates objects whose
 * name starts with the configured prefix (`dokploy-` by default), so an
 * existing NetBird install keeps its own groups, policies and peers.
 */
export const netbird = (context: ProviderContext): MeshProvider => {
	const api = <T>(path: string, init: RequestInit = {}) =>
		request<T>(context, `/api${path}`, { ...init, auth: "token" });
	const prefix = context.settings.groupPrefix || "dokploy";
	const groupNames = {
		control: `${prefix}-control`,
		servers: `${prefix}-servers`,
	};
	const policyNames = {
		controlToServers: `${prefix}-control-to-servers`,
		swarm: `${prefix}-swarm`,
	};

	const groups = () => api<NbGroup[]>("/groups");

	const ensureGroup = async (name: string, dryRun: boolean) => {
		const existing = (await groups()).find((group) => group.name === name);
		if (existing) return { group: existing, created: false };
		if (dryRun) return { group: null, created: true };
		const created = await api<NbGroup>("/groups", {
			method: "POST",
			body: JSON.stringify({ name, peers: [] }),
		});
		return { group: created, created: true };
	};

	const rule = (
		name: string,
		sources: string[],
		destinations: string[],
		protocol: "tcp" | "udp",
		ports: number[],
	) => ({
		name,
		description: "Managed by Dokploy",
		enabled: true,
		action: "accept",
		bidirectional: false,
		protocol,
		ports: ports.map(String),
		sources,
		destinations,
	});

	return {
		kind: "netbird",

		async test() {
			const peers = await api<NbPeer[]>("/peers");
			return {
				ok: true,
				detail: `Reachable, ${peers.length} peer${peers.length === 1 ? "" : "s"} in the network`,
			};
		},

		async listPeers(): Promise<MeshPeer[]> {
			const peers = await api<NbPeer[]>("/peers");
			return peers.map((peer) => ({
				id: peer.id,
				name: peer.name,
				ip: peer.ip,
				hostname: peer.dns_label,
				connected: !!peer.connected,
				lastSeen: peer.last_seen,
				version: peer.version,
				os: peer.os,
			}));
		},

		async createEnrollmentKey(name: string): Promise<EnrollmentKey> {
			const servers = await ensureGroup(groupNames.servers, false);
			const created = await api<{ key: string; expires: string }>(
				"/setup-keys",
				{
					method: "POST",
					body: JSON.stringify({
						name: `${prefix}-${name}`,
						type: "one-off",
						// One hour is plenty for an enrollment and limits the blast
						// radius if the key leaks.
						expires_in: 3600,
						usage_limit: 1,
						ephemeral: false,
						auto_groups: servers.group ? [servers.group.id] : [],
					}),
				},
			);
			if (!created?.key)
				throw new MeshApiError("NetBird returned no setup key");
			return { key: created.key, expiresAt: created.expires };
		},

		joinCommand(key: string, hostname: string) {
			const dns = context.settings.manageDns ? "" : " --disable-dns";
			return [
				"curl -fsSL https://pkgs.netbird.io/install.sh | sh",
				`netbird up --setup-key '${key}' --management-url '${context.baseUrl}' --hostname '${hostname}'${dns} --allow-server-ssh=false`,
			].join(" && ");
		},

		leaveCommand() {
			return "netbird down; netbird status || true";
		},

		async removePeer(peerId: string) {
			await api(`/peers/${peerId}`, { method: "DELETE" });
		},

		async ensurePolicy(dryRun: boolean): Promise<PolicyPlan> {
			const plan: PolicyPlan = { create: [], keep: [], remove: [] };
			const control = await ensureGroup(groupNames.control, dryRun);
			const servers = await ensureGroup(groupNames.servers, dryRun);
			for (const [name, result] of [
				[groupNames.control, control],
				[groupNames.servers, servers],
			] as const) {
				(result.created ? plan.create : plan.keep).push(`group ${name}`);
			}
			if (dryRun && (!control.group || !servers.group)) {
				plan.create.push(
					`policy ${policyNames.controlToServers}`,
					`policy ${policyNames.swarm}`,
				);
				return plan;
			}
			const controlId = control.group?.id as string;
			const serversId = servers.group?.id as string;

			const existing = await api<NbPolicy[]>("/policies");
			const wanted = [
				{
					name: policyNames.controlToServers,
					rules: [
						rule(
							policyNames.controlToServers,
							[controlId],
							[serversId],
							"tcp",
							[context.settings.sshPort, 4500],
						),
					],
				},
				...(context.settings.swarmOverMesh
					? [
							{
								name: policyNames.swarm,
								rules: [
									rule(
										`${policyNames.swarm}-tcp`,
										[serversId],
										[serversId],
										"tcp",
										SWARM_PORTS.tcp,
									),
									rule(
										`${policyNames.swarm}-udp`,
										[serversId],
										[serversId],
										"udp",
										SWARM_PORTS.udp,
									),
								],
							},
						]
					: []),
			];

			for (const policy of wanted) {
				const found = existing.find((row) => row.name === policy.name);
				if (found) {
					plan.keep.push(`policy ${policy.name}`);
					continue;
				}
				plan.create.push(`policy ${policy.name}`);
				if (dryRun) continue;
				await api("/policies", {
					method: "POST",
					body: JSON.stringify({
						name: policy.name,
						description: "Managed by Dokploy",
						enabled: true,
						rules: policy.rules,
					}),
				});
			}

			// A Dokploy policy that is no longer wanted, e.g. swarm turned off.
			for (const row of existing) {
				if (!row.name.startsWith(`${prefix}-`)) continue;
				if (wanted.some((policy) => policy.name === row.name)) continue;
				plan.remove.push(`policy ${row.name}`);
				if (!dryRun) await api(`/policies/${row.id}`, { method: "DELETE" });
			}
			return plan;
		},
	};
};

/** Approves a peer when the NetBird account requires approval. */
export const approveNetbirdPeer = async (
	context: ProviderContext,
	peerId: string,
) => {
	await request(context, `/api/peers/${peerId}`, {
		method: "PUT",
		auth: "token",
		body: JSON.stringify({ approval_required: false }),
	});
};
