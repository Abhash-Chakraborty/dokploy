import {
	type EnrollmentKey,
	MeshApiError,
	type MeshPeer,
	type MeshProvider,
	type PolicyPlan,
	type ProviderContext,
	request,
} from "./types";

type HsNode = {
	id: string;
	name: string;
	givenName?: string;
	ipAddresses?: string[];
	online?: boolean;
	lastSeen?: string;
	forcedTags?: string[];
};

/**
 * The Tailscale client against a self-hosted Headscale. Policy stays with
 * you: Dokploy shows the grants to paste rather than writing your policy
 * file, so it can never break access you set up by hand.
 */
export const headscale = (context: ProviderContext): MeshProvider => {
	const api = <T>(path: string, init: RequestInit = {}) =>
		request<T>(context, `/api/v1${path}`, { ...init, auth: "bearer" });
	const prefix = context.settings.groupPrefix || "dokploy";
	const tag = `tag:${prefix}-server`;
	const user = prefix;

	return {
		kind: "headscale",

		async test() {
			const nodes = await api<{ nodes: HsNode[] }>("/node");
			const count = nodes.nodes?.length ?? 0;
			return {
				ok: true,
				detail: `Reachable, ${count} node${count === 1 ? "" : "s"} registered`,
			};
		},

		async listPeers(): Promise<MeshPeer[]> {
			const { nodes } = await api<{ nodes: HsNode[] }>("/node");
			return (nodes ?? []).map((node) => ({
				id: node.id,
				name: node.givenName || node.name,
				ip: node.ipAddresses?.[0] ?? "",
				hostname: node.name,
				connected: !!node.online,
				lastSeen: node.lastSeen,
			}));
		},

		async createEnrollmentKey(): Promise<EnrollmentKey> {
			const expiration = new Date(Date.now() + 3_600_000).toISOString();
			const created = await api<{ preAuthKey?: { key: string } }>(
				"/preauthkey",
				{
					method: "POST",
					body: JSON.stringify({
						user,
						reusable: false,
						ephemeral: false,
						expiration,
						aclTags: [tag],
					}),
				},
			);
			const key = created?.preAuthKey?.key;
			if (!key) throw new MeshApiError("Headscale returned no pre-auth key");
			return { key, expiresAt: expiration };
		},

		joinCommand(key: string, hostname: string) {
			const dns = context.settings.manageDns ? "" : " --accept-dns=false";
			return [
				"curl -fsSL https://tailscale.com/install.sh | sh",
				`tailscale up --login-server '${context.baseUrl}' --authkey '${key}' --hostname '${hostname}' --advertise-tags '${tag}'${dns} --ssh=false`,
			].join(" && ");
		},

		leaveCommand() {
			return "tailscale logout || true; tailscale down || true";
		},

		async removePeer(peerId: string) {
			await api(`/node/${peerId}`, { method: "DELETE" });
		},

		async ensurePolicy(): Promise<PolicyPlan> {
			// Snippet mode only: Dokploy never writes a Headscale policy.
			return {
				create: [],
				keep: [`tag ${tag} (assigned to the servers Dokploy enrolls)`],
				remove: [],
			};
		},
	};
};

/** The grants to paste into a Headscale policy, shown next to the provider. */
export const headscalePolicySnippet = (prefix: string, sshPort: number) =>
	JSON.stringify(
		{
			tagOwners: { [`tag:${prefix}-server`]: [`${prefix}`] },
			grants: [
				{
					src: [`tag:${prefix}-control`],
					dst: [`tag:${prefix}-server`],
					ip: [`tcp:${sshPort}`, "tcp:4500"],
				},
			],
		},
		null,
		2,
	);
