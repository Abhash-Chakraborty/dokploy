import { relations } from "drizzle-orm";
import {
	boolean,
	index,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { member, organization } from "./account";
import { user } from "./user";

export type AbhashSource = "manual" | "sso" | "scim" | "legacy";
export type BindingSubject = "user" | "team";
export type BindingScope =
	| "organization"
	| "project"
	| "environment"
	| "service"
	| "server"
	| "gitProvider";

/** Instance-wide fork settings and feature flags. */
export const abhashSettings = pgTable("abhash_settings", {
	key: text("key").primaryKey(),
	value: jsonb("value").notNull(),
	updatedBy: text("updated_by"),
	updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const abhashTeam = pgTable(
	"abhash_team",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		description: text("description"),
		source: text("source").$type<AbhashSource>().notNull().default("manual"),
		externalId: text("external_id"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(t) => [
		uniqueIndex("abhash_team_org_slug_idx").on(t.organizationId, t.slug),
		index("abhash_team_external_idx").on(t.organizationId, t.externalId),
	],
);

export const abhashTeamMember = pgTable(
	"abhash_team_member",
	{
		teamId: text("team_id")
			.notNull()
			.references(() => abhashTeam.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		// A membership can come from several places at once; sync from SSO or
		// SCIM only ever touches its own rows.
		source: text("source").$type<AbhashSource>().notNull().default("manual"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.teamId, t.userId, t.source] }),
		index("abhash_team_member_user_idx").on(t.userId),
	],
);

/**
 * Grants `role` to a user or team on a scope. `organization` scope covers
 * every project; project and environment scopes cover what is inside them
 * when `inherit` is set. The role "@org" means "the member's organization
 * role", which is how pre-existing per-resource access is represented.
 */
export const abhashRoleBinding = pgTable(
	"abhash_role_binding",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		subjectType: text("subject_type").$type<BindingSubject>().notNull(),
		subjectId: text("subject_id").notNull(),
		role: text("role").notNull(),
		scopeType: text("scope_type").$type<BindingScope>().notNull(),
		// Empty for organization scope, so the unique index needs no COALESCE.
		scopeId: text("scope_id").notNull().default(""),
		inherit: boolean("inherit").notNull().default(true),
		source: text("source").$type<AbhashSource>().notNull().default("manual"),
		createdBy: text("created_by"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex("abhash_role_binding_unique_idx").on(
			t.organizationId,
			t.subjectType,
			t.subjectId,
			t.role,
			t.scopeType,
			t.scopeId,
		),
		index("abhash_role_binding_subject_idx").on(
			t.organizationId,
			t.subjectType,
			t.subjectId,
		),
		index("abhash_role_binding_scope_idx").on(t.scopeType, t.scopeId),
	],
);

export const abhashMemberMeta = pgTable("abhash_member_meta", {
	memberId: text("member_id")
		.primaryKey()
		.references(() => member.id, { onDelete: "cascade" }),
	roleSource: text("role_source")
		.$type<AbhashSource>()
		.notNull()
		.default("manual"),
	// When set, SSO/SCIM group sync never changes this member's role.
	rolePinned: boolean("role_pinned").notNull().default(false),
	lastSsoSyncAt: timestamp("last_sso_sync_at"),
});

export const abhashUserSuspension = pgTable("abhash_user_suspension", {
	userId: text("user_id")
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	suspendedAt: timestamp("suspended_at").defaultNow().notNull(),
	suspendedBy: text("suspended_by"),
	source: text("source").$type<AbhashSource>().notNull().default("manual"),
	reason: text("reason"),
	// Keys disabled by the suspension, so reactivation re-enables only those.
	disabledApiKeyIds: text("disabled_api_key_ids").array().notNull().default([]),
});

export const abhashTeamRelations = relations(abhashTeam, ({ many, one }) => ({
	members: many(abhashTeamMember),
	organization: one(organization, {
		fields: [abhashTeam.organizationId],
		references: [organization.id],
	}),
}));

export const abhashTeamMemberRelations = relations(
	abhashTeamMember,
	({ one }) => ({
		team: one(abhashTeam, {
			fields: [abhashTeamMember.teamId],
			references: [abhashTeam.id],
		}),
		user: one(user, {
			fields: [abhashTeamMember.userId],
			references: [user.id],
		}),
	}),
);
