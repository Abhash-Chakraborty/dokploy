import { relations } from "drizzle-orm";
import { boolean, jsonb, pgEnum, pgTable, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { server } from "./server";

export const logDrainType = pgEnum("LogDrainType", ["loki", "datadog", "http"]);

const httpUrl = z
	.string()
	.trim()
	.min(1)
	.refine((value) => /^https?:\/\//i.test(value), {
		message: "Only http:// and https:// URLs are allowed",
	});

export const lokiDrainConfigSchema = z.object({
	drainType: z.literal("loki"),
	/** Base URL of the Loki instance, e.g. http://loki:3100 */
	endpoint: httpUrl,
	/** Optional basic-auth for Grafana Cloud and friends. */
	username: z.string().trim().optional(),
	password: z.string().optional(),
	/** Static labels attached to every stream. */
	labels: z.record(z.string(), z.string()).default({}),
});

export const datadogDrainConfigSchema = z.object({
	drainType: z.literal("datadog"),
	/** e.g. https://http-intake.logs.datadoghq.com — region specific. */
	endpoint: httpUrl.default("https://http-intake.logs.datadoghq.com"),
	apiKey: z.string().trim().min(1),
	site: z.string().trim().default("datadoghq.com"),
	tags: z.string().trim().optional(),
});

export const httpDrainConfigSchema = z.object({
	drainType: z.literal("http"),
	endpoint: httpUrl,
	/** Sent verbatim; use for bearer tokens or vendor-specific keys. */
	headers: z.record(z.string(), z.string()).default({}),
	encoding: z.enum(["json", "text"]).default("json"),
});

export const logDrainConfigSchema = z.discriminatedUnion("drainType", [
	lokiDrainConfigSchema,
	datadogDrainConfigSchema,
	httpDrainConfigSchema,
]);

export type LogDrainConfig = z.infer<typeof logDrainConfigSchema>;

export const logDrain = pgTable("log_drain", {
	logDrainId: text("logDrainId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	name: text("name").notNull(),
	drainType: logDrainType("drainType").notNull(),
	config: jsonb("config").$type<LogDrainConfig>().notNull(),
	enabled: boolean("enabled").notNull().default(true),
	/** Null means the Dokploy host itself. */
	serverId: text("serverId").references(() => server.serverId, {
		onDelete: "cascade",
	}),
	/** Last deploy/removal outcome, surfaced in the UI. */
	status: text("status").notNull().default("pending"),
	statusMessage: text("statusMessage"),
	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const logDrainRelations = relations(logDrain, ({ one }) => ({
	organization: one(organization, {
		fields: [logDrain.organizationId],
		references: [organization.id],
	}),
	server: one(server, {
		fields: [logDrain.serverId],
		references: [server.serverId],
	}),
}));

const createSchema = createInsertSchema(logDrain);

export const apiCreateLogDrain = createSchema
	.pick({ name: true, serverId: true, enabled: true })
	.extend({
		name: z.string().trim().min(1),
		config: logDrainConfigSchema,
		serverId: z.string().nullish(),
		enabled: z.boolean().default(true),
	});

export const apiUpdateLogDrain = apiCreateLogDrain.partial().extend({
	logDrainId: z.string().min(1),
});

export const apiFindOneLogDrain = z.object({
	logDrainId: z.string().min(1),
});
