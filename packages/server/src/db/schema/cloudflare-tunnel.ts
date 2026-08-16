import { relations } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { server } from "./server";

/**
 * A Cloudflare Tunnel lets a host serve traffic without a public IP or any
 * inbound port. The panel doesn't create the tunnel — that happens in the
 * Cloudflare dashboard, which is also where ingress rules live — it runs the
 * connector for you and reports whether it's up.
 */
export const cloudflareTunnel = pgTable("cloudflare_tunnel", {
	cloudflareTunnelId: text("cloudflareTunnelId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	name: text("name").notNull(),
	/** The connector token from Cloudflare Zero Trust. Write-only over the API. */
	token: text("token").notNull(),
	/** Null means the Dokploy host itself. */
	serverId: text("serverId").references(() => server.serverId, {
		onDelete: "cascade",
	}),
	status: text("status").notNull().default("pending"),
	statusMessage: text("statusMessage"),
	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const cloudflareTunnelRelations = relations(
	cloudflareTunnel,
	({ one }) => ({
		organization: one(organization, {
			fields: [cloudflareTunnel.organizationId],
			references: [organization.id],
		}),
		server: one(server, {
			fields: [cloudflareTunnel.serverId],
			references: [server.serverId],
		}),
	}),
);

const createSchema = createInsertSchema(cloudflareTunnel);

export const apiCreateCloudflareTunnel = createSchema
	.pick({ name: true })
	.extend({
		name: z.string().trim().min(1),
		// Connector tokens are long base64 blobs; reject obvious paste errors
		// early rather than after a container fails to start.
		token: z
			.string()
			.trim()
			.min(32, "That doesn't look like a connector token")
			.regex(/^[A-Za-z0-9+/=_-]+$/, "Token contains unexpected characters"),
		serverId: z.string().nullish(),
	});

export const apiUpdateCloudflareTunnel = z.object({
	cloudflareTunnelId: z.string().min(1),
	name: z.string().trim().min(1).optional(),
	token: z.string().trim().min(32).optional(),
	serverId: z.string().nullish(),
});

export const apiFindOneCloudflareTunnel = z.object({
	cloudflareTunnelId: z.string().min(1),
});
