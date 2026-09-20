import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";
import { compose } from "./compose";
import { environments } from "./environment";

/**
 * A service Dokploy manages from an engine definition: the compose stack is
 * generated, so the whole existing pipeline (deploy, logs, domains, volumes,
 * permissions) applies unchanged.
 */
export const abhashManagedService = pgTable("abhash_managed_service", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => nanoid()),
	organizationId: text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	environmentId: text("environment_id")
		.notNull()
		.references(() => environments.environmentId, { onDelete: "cascade" }),
	composeId: text("compose_id")
		.notNull()
		.references(() => compose.composeId, { onDelete: "cascade" }),
	engine: text("engine").notNull(),
	version: text("version").notNull(),
	config: jsonb("config")
		.$type<Record<string, string | number | boolean>>()
		.notNull()
		.default({}),
	createdBy: text("created_by"),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
