import {
	boolean,
	index,
	integer,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";

export const WEBHOOK_EVENTS = [
	"job.succeeded",
	"job.failed",
	"backup.failed",
	"backup.stale",
	"drill.failed",
	"approval.requested",
	"server.offline",
	"firewall.drift",
	"secret.expiring",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Where Dokploy pushes events, so an agent does not have to poll. */
export const abhashWebhook = pgTable(
	"abhash_webhook",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		url: text("url").notNull(),
		/** Signs every delivery; a vault reference or a literal. */
		secretRef: text("secret_ref").notNull(),
		events: text("events").array().$type<WebhookEvent[]>().notNull().default([]),
		enabled: boolean("enabled").notNull().default(true),
		lastStatus: integer("last_status"),
		lastError: text("last_error"),
		lastDeliveredAt: timestamp("last_delivered_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [index("abhash_webhook_org_idx").on(t.organizationId)],
);
