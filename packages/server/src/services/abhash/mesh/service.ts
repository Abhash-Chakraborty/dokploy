import { and, eq } from "drizzle-orm";
import { db } from "../../../db";
import {
	abhashMeshProvider,
	abhashServerMesh,
	DEFAULT_MESH_SETTINGS,
	type MeshKind,
	type MeshSettings,
	server,
} from "../../../db/schema";
import { resolveSecretRefs } from "../vault/secrets";
import { headscale } from "./headscale";
import { netbird } from "./netbird";
import type { MeshProvider } from "./types";

export type ProviderRow = typeof abhashMeshProvider.$inferSelect;

export const listProviders = (organizationId: string) =>
	db.query.abhashMeshProvider.findMany({
		where: eq(abhashMeshProvider.organizationId, organizationId),
		orderBy: (provider, { asc }) => [asc(provider.name)],
	});

export const activeProvider = (organizationId: string) =>
	db.query.abhashMeshProvider.findFirst({
		where: and(
			eq(abhashMeshProvider.organizationId, organizationId),
			eq(abhashMeshProvider.active, true),
		),
	});

export const findProvider = async (organizationId: string, id: string) => {
	const row = await db.query.abhashMeshProvider.findFirst({
		where: and(
			eq(abhashMeshProvider.id, id),
			eq(abhashMeshProvider.organizationId, organizationId),
		),
	});
	if (!row) throw new Error("Mesh provider not found");
	return row;
};

const builders: Record<
	MeshKind,
	(context: {
		baseUrl: string;
		token: string;
		settings: MeshSettings;
	}) => MeshProvider
> = { netbird, headscale };

/** Builds a client, resolving the API token from the vault just in time. */
export const clientFor = async (row: ProviderRow): Promise<MeshProvider> => {
	const token =
		(await resolveSecretRefs(row.tokenRef, {
			organizationId: row.organizationId,
			projectId: row.organizationId,
		})) ?? "";
	if (!token || token === row.tokenRef) {
		throw new Error(
			`The API token for ${row.name} is not in the vault: set ${row.tokenRef}`,
		);
	}
	return builders[row.kind]({
		baseUrl: row.baseUrl,
		token,
		settings: { ...DEFAULT_MESH_SETTINGS, ...row.settings },
	});
};

/** Exactly one provider is active; switching is deliberate and audited. */
export const setActiveProvider = async (
	organizationId: string,
	id: string | null,
) => {
	await db.transaction(async (tx) => {
		await tx
			.update(abhashMeshProvider)
			.set({ active: false })
			.where(eq(abhashMeshProvider.organizationId, organizationId));
		if (id) {
			await tx
				.update(abhashMeshProvider)
				.set({ active: true })
				.where(
					and(
						eq(abhashMeshProvider.id, id),
						eq(abhashMeshProvider.organizationId, organizationId),
					),
				);
		}
	});
	return activeProvider(organizationId);
};

export const meshName = (serverName: string) =>
	`dokploy-${serverName
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")}`.slice(0, 60);

export const serverMesh = (serverId: string) =>
	db.query.abhashServerMesh.findFirst({
		where: eq(abhashServerMesh.serverId, serverId),
	});

/**
 * Matches the mesh's peers to Dokploy's servers, so a server already in the
 * mesh (like the machine Dokploy runs on) is adopted instead of re-enrolled.
 */
export const syncPeers = async (organizationId: string) => {
	const provider = await activeProvider(organizationId);
	if (!provider) return { matched: 0, peers: 0 };
	const client = await clientFor(provider);
	const peers = await client.listPeers();
	const servers = await db.query.server.findMany({
		where: eq(server.organizationId, organizationId),
		columns: { serverId: true, name: true, ipAddress: true },
	});
	let matched = 0;
	for (const row of servers) {
		const existing = await serverMesh(row.serverId);
		const peer =
			peers.find((candidate) => candidate.id === existing?.peerId) ??
			peers.find((candidate) => candidate.name === meshName(row.name)) ??
			peers.find((candidate) => candidate.ip === row.ipAddress) ??
			peers.find((candidate) => candidate.hostname === row.name);
		if (!peer) continue;
		matched++;
		const values = {
			providerId: provider.id,
			peerId: peer.id,
			meshIp: peer.ip,
			meshHostname: peer.hostname ?? peer.name,
			status: peer.connected
				? ("connected" as const)
				: ("disconnected" as const),
			clientVersion: peer.version ?? null,
			lastSeenAt: peer.lastSeen ? new Date(peer.lastSeen) : new Date(),
		};
		await db
			.insert(abhashServerMesh)
			.values({
				serverId: row.serverId,
				adopted: !existing,
				joinedAt: existing?.joinedAt ?? null,
				...values,
			})
			.onConflictDoUpdate({
				target: abhashServerMesh.serverId,
				set: values,
			});
	}
	await db
		.update(abhashMeshProvider)
		.set({ lastSyncAt: new Date(), lastSyncError: null })
		.where(eq(abhashMeshProvider.id, provider.id));
	return { matched, peers: peers.length };
};
