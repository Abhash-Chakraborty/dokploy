import {
	boolean,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";

/**
 * A forward-auth gate for deployed apps: rendered as a Traefik forwardAuth
 * middleware named `abhash-fa-<slug>` in every server's dynamic config, and
 * applied to a domain by adding `abhash-fa-<slug>@file` to its middlewares.
 */
export const abhashForwardAuth = pgTable(
	"abhash_forward_auth",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		kind: text("kind").$type<"authentik" | "generic">().notNull(),
		// Authentik: its public URL. Generic: unused.
		baseUrl: text("base_url"),
		// The forwardAuth address Traefik calls for every request.
		address: text("address").notNull(),
		trustForwardHeader: boolean("trust_forward_header").notNull().default(true),
		authResponseHeaders: text("auth_response_headers")
			.array()
			.notNull()
			.default([]),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [uniqueIndex("abhash_forward_auth_slug_idx").on(t.slug)],
);
