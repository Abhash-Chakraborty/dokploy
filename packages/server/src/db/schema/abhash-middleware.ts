import {
	boolean,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";

export type MiddlewareScope = "manual" | "all" | "projects";

/**
 * A Traefik middleware defined from the dashboard. Dokploy writes the
 * definition to a dynamic file on every server the organization uses and
 * attaches it to routers according to its scope, so nothing is edited by
 * hand.
 */
export const abhashTraefikMiddleware = pgTable(
	"abhash_traefik_middleware",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description"),
		kind: text("kind").notNull(),
		config: jsonb("config").$type<Record<string, unknown>>().notNull(),
		scope: text("scope").$type<MiddlewareScope>().notNull().default("manual"),
		projectIds: text("project_ids").array().notNull().default([]),
		applyToDashboard: boolean("apply_to_dashboard").notNull().default(false),
		enabled: boolean("enabled").notNull().default(true),
		// Kept as a no-op definition after deletion, so a compose service that
		// still carries the label reference keeps routing until it redeploys.
		deletedAt: timestamp("deleted_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("abhash_traefik_middleware_org_name").on(
			table.organizationId,
			table.name,
		),
	],
);
