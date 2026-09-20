import {
	boolean,
	index,
	integer,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { abhashTeam } from "./abhash-rbac";
import { organization } from "./account";
import { ssoProvider } from "./sso";

/** Fork settings for an OIDC provider stored in sso_provider. */
export const abhashSsoProvider = pgTable("abhash_sso_provider", {
	providerId: text("provider_id")
		.primaryKey()
		.references(() => ssoProvider.providerId, { onDelete: "cascade" }),
	displayName: text("display_name").notNull(),
	kind: text("kind")
		.$type<"authentik" | "generic">()
		.notNull()
		.default("generic"),
	enabled: boolean("enabled").notNull().default(false),
	showOnLogin: boolean("show_on_login").notNull().default(true),
	// Create accounts on first sign-in; otherwise only invited people get in.
	jitEnabled: boolean("jit_enabled").notNull().default(true),
	// Deny sign-in when none of the user's groups is mapped.
	requireGroupMatch: boolean("require_group_match").notNull().default(false),
	groupsClaim: text("groups_claim").notNull().default("groups"),
	defaultRole: text("default_role").notNull().default("member"),
	// Highest organization role group mappings may grant ("admin" or "member").
	maxRole: text("max_role").notNull().default("admin"),
	lastLoginAt: timestamp("last_login_at"),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const abhashSsoGroupMapping = pgTable(
	"abhash_sso_group_mapping",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		// Null applies to every provider of the organization.
		providerId: text("provider_id").references(() => ssoProvider.providerId, {
			onDelete: "cascade",
		}),
		groupName: text("group_name").notNull(),
		orgRole: text("org_role"),
		teamId: text("team_id").references(() => abhashTeam.id, {
			onDelete: "cascade",
		}),
		priority: integer("priority").notNull().default(0),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [index("abhash_sso_group_mapping_org_idx").on(t.organizationId)],
);
