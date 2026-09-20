import { sql } from "drizzle-orm";
import {
	boolean,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";
import { server } from "./server";

export type MeshKind = "netbird" | "headscale";

export type MeshSettings = {
	/** Groups and tags Dokploy manages; it never touches anything else. */
	groupPrefix: string;
	/** Servers join with DNS management off, so container DNS is untouched. */
	manageDns: boolean;
	sshPort: number;
	/** Swarm over the mesh needs a smaller overlay MTU than the default. */
	swarmOverMesh: boolean;
};

export const DEFAULT_MESH_SETTINGS: MeshSettings = {
	groupPrefix: "dokploy",
	manageDns: false,
	sshPort: 22,
	swarmOverMesh: false,
};

/**
 * The mesh Dokploy manages. One provider is active per organization: the
 * servers' addresses and firewall rules follow it, so two at once would be
 * ambiguous.
 */
export const abhashMeshProvider = pgTable(
	"abhash_mesh_provider",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		kind: text("kind").$type<MeshKind>().notNull(),
		name: text("name").notNull(),
		/** Management URL: self-hosted NetBird, or Headscale. */
		baseUrl: text("base_url").notNull(),
		/** ${{secret.NAME}} for the API token; the value never lives here. */
		tokenRef: text("token_ref").notNull(),
		settings: jsonb("settings")
			.$type<MeshSettings>()
			.notNull()
			.default(DEFAULT_MESH_SETTINGS),
		active: boolean("active").notNull().default(false),
		lastSyncAt: timestamp("last_sync_at"),
		lastSyncError: text("last_sync_error"),
		createdBy: text("created_by"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex("abhash_mesh_provider_name_idx").on(t.organizationId, t.name),
		// At most one active provider per organization.
		uniqueIndex("abhash_mesh_provider_active_idx")
			.on(t.organizationId)
			.where(sql`${t.active}`),
	],
);

export type MeshPeerStatus = "unknown" | "connected" | "disconnected";

export const abhashServerMesh = pgTable(
	"abhash_server_mesh",
	{
		serverId: text("server_id")
			.primaryKey()
			.references(() => server.serverId, { onDelete: "cascade" }),
		providerId: text("provider_id")
			.notNull()
			.references(() => abhashMeshProvider.id, { onDelete: "cascade" }),
		peerId: text("peer_id"),
		meshIp: text("mesh_ip"),
		meshHostname: text("mesh_hostname"),
		status: text("status").$type<MeshPeerStatus>().notNull().default("unknown"),
		clientVersion: text("client_version"),
		/** Adopted peers were already in the mesh; Dokploy did not enroll them. */
		adopted: boolean("adopted").notNull().default(false),
		joinedAt: timestamp("joined_at"),
		lastSeenAt: timestamp("last_seen_at"),
	},
	(t) => [index("abhash_server_mesh_provider_idx").on(t.providerId)],
);
