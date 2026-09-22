import { db } from "@dokploy/server/db";
import { abhashTraefikMiddleware } from "@dokploy/server/db/schema";
import {
	checkCustomMiddleware,
	listMiddlewares,
	middlewareRef,
	projectIdsIn,
	publishMiddlewares,
	renderMiddleware,
} from "@dokploy/server/services/abhash/middlewares";
import { TRPCError } from "@trpc/server";
import * as bcrypt from "bcrypt";
import { and, eq, isNull } from "drizzle-orm";
import { parse } from "yaml";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
} from "../../trpc";

const duration = z.string().regex(/^\d+(ms|s|m|h)$/, "e.g. 1s, 1m, 1h");
const cidr = z
	.string()
	.trim()
	.regex(
		/^([0-9a-fA-F:.]+)(\/\d{1,3})?$/,
		"An IP address or a range like 10.0.0.0/8",
	);
const headerMap = z.record(
	z.string().regex(/^[A-Za-z0-9-]+$/, "Header names are letters, digits and -"),
	z.string().max(2000),
);

const config = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("rateLimit"),
		average: z.number().int().min(1),
		burst: z.number().int().min(1),
		period: duration.default("1s"),
	}),
	z.object({
		kind: z.literal("ipAllowList"),
		sourceRange: z.array(cidr).min(1),
		depth: z.number().int().min(0).max(10).optional(),
	}),
	z.object({
		kind: z.literal("basicAuth"),
		// A blank password keeps that user's existing hash.
		users: z
			.array(
				z.object({
					username: z
						.string()
						.trim()
						.regex(/^[^:\s]+$/, "No spaces or colons"),
					password: z.string().max(200).default(""),
				}),
			)
			.min(1),
	}),
	z.object({
		kind: z.literal("securityHeaders"),
		stsSeconds: z.number().int().min(0).default(31536000),
		frameDeny: z.boolean().default(true),
		contentTypeNosniff: z.boolean().default(true),
		browserXssFilter: z.boolean().default(true),
		referrerPolicy: z.string().default("strict-origin-when-cross-origin"),
	}),
	z.object({
		kind: z.literal("headers"),
		requestHeaders: headerMap.default({}),
		responseHeaders: headerMap.default({}),
	}),
	z.object({
		kind: z.literal("redirectRegex"),
		regex: z.string().min(1).max(500),
		replacement: z.string().min(1).max(500),
		permanent: z.boolean().default(false),
	}),
	z.object({ kind: z.literal("compress") }),
	z.object({
		kind: z.literal("retry"),
		attempts: z.number().int().min(1).max(10).default(3),
	}),
	z.object({
		kind: z.literal("inFlightReq"),
		amount: z.number().int().min(1),
	}),
	z.object({
		kind: z.literal("buffering"),
		maxRequestBodyBytes: z.number().int().min(1),
	}),
	z.object({
		kind: z.literal("stripPrefix"),
		prefixes: z.array(z.string().regex(/^\/\S*$/, "Starts with /")).min(1),
	}),
	z.object({
		kind: z.literal("custom"),
		yaml: z.string().min(1).max(20_000),
	}),
]);

const input = z.object({
	name: z
		.string()
		.trim()
		.min(1)
		.max(40)
		.regex(/^[a-z0-9][a-z0-9-]*$/, "Lowercase letters, numbers and hyphens"),
	description: z.string().trim().max(200).optional(),
	config,
	scope: z.enum(["manual", "all", "projects"]).default("manual"),
	projectIds: z.array(z.string()).default([]),
	applyToDashboard: z.boolean().default(false),
	enabled: z.boolean().default(true),
});

type Row = typeof abhashTraefikMiddleware.$inferSelect;

/** What the database keeps: passwords hashed, custom YAML parsed. */
const toStored = async (
	value: z.infer<typeof config>,
	existing?: Row,
): Promise<Record<string, unknown>> => {
	if (value.kind === "basicAuth") {
		const previous = new Map(
			((existing?.config?.users as string[] | undefined) ?? []).map((line) => [
				line.slice(0, line.indexOf(":")),
				line,
			]),
		);
		const users: string[] = [];
		for (const user of value.users) {
			if (user.password) {
				users.push(`${user.username}:${await bcrypt.hash(user.password, 10)}`);
			} else if (previous.has(user.username)) {
				users.push(previous.get(user.username) as string);
			} else {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Set a password for ${user.username}`,
				});
			}
		}
		return { users };
	}
	if (value.kind === "custom") {
		let definition: unknown;
		try {
			definition = parse(value.yaml);
		} catch (error) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `The YAML does not parse: ${error instanceof Error ? error.message : error}`,
			});
		}
		const problem = checkCustomMiddleware(definition);
		if (problem) {
			throw new TRPCError({ code: "BAD_REQUEST", message: problem });
		}
		return { yaml: value.yaml, definition };
	}
	const { kind: _kind, ...rest } = value;
	return rest;
};

const maskHashes = (definition: Record<string, unknown>) => {
	const basicAuth = definition.basicAuth as { users?: string[] } | undefined;
	if (!basicAuth?.users) return definition;
	return {
		...definition,
		basicAuth: {
			...basicAuth,
			users: basicAuth.users.map(
				(line) => `${line.slice(0, line.indexOf(":"))}:<bcrypt hash>`,
			),
		},
	};
};

/** Never hands password hashes back to the browser. */
const toClient = (row: Row) => ({
	...row,
	config:
		row.kind === "basicAuth"
			? {
					users: ((row.config.users as string[]) ?? []).map((line) => ({
						username: line.slice(0, line.indexOf(":")),
						password: "",
					})),
				}
			: row.kind === "custom"
				? { yaml: row.config.yaml }
				: row.config,
	ref: middlewareRef(row),
	preview: maskHashes(renderMiddleware(row)),
});

const findOwn = async (organizationId: string, id: string) => {
	const row = await db.query.abhashTraefikMiddleware.findFirst({
		where: and(
			eq(abhashTraefikMiddleware.id, id),
			eq(abhashTraefikMiddleware.organizationId, organizationId),
			isNull(abhashTraefikMiddleware.deletedAt),
		),
	});
	if (!row)
		throw new TRPCError({ code: "NOT_FOUND", message: "Middleware not found" });
	return row;
};

const guardDashboard = (role: string, wants: boolean, had = false) => {
	// The dashboard router is shared by every organization on the instance.
	if (wants !== had && role !== "owner") {
		throw new TRPCError({
			code: "FORBIDDEN",
			message:
				"Only the owner can put middlewares in front of the Dokploy dashboard",
		});
	}
};

export const abhashMiddlewaresRouter = createTRPCRouter({
	list: adminProcedure.query(async ({ ctx }) =>
		(await listMiddlewares(ctx.session.activeOrganizationId))
			.filter((row) => !row.deletedAt)
			.map(toClient),
	),

	/** For the domain dialog: what can be picked on a single domain. */
	options: protectedProcedure.query(async ({ ctx }) =>
		(await listMiddlewares(ctx.session.activeOrganizationId))
			.filter((row) => !row.deletedAt && row.enabled)
			.map((row) => ({
				name: row.name,
				description: row.description,
				kind: row.kind,
				scope: row.scope,
				ref: middlewareRef(row),
			})),
	),

	create: adminProcedure
		.input(input)
		.mutation(async ({ ctx, input: value }) => {
			const organizationId = ctx.session.activeOrganizationId;
			guardDashboard(ctx.user.role, value.applyToDashboard);
			const taken = await db.query.abhashTraefikMiddleware.findFirst({
				where: and(
					eq(abhashTraefikMiddleware.organizationId, organizationId),
					eq(abhashTraefikMiddleware.name, value.name),
				),
			});
			if (taken && !taken.deletedAt) {
				throw new TRPCError({
					code: "CONFLICT",
					message: `${value.name} already exists`,
				});
			}
			const values = {
				organizationId,
				name: value.name,
				description: value.description ?? null,
				kind: value.config.kind,
				config: await toStored(value.config),
				scope: value.scope,
				projectIds:
					value.scope === "projects"
						? await projectIdsIn(organizationId, value.projectIds)
						: [],
				applyToDashboard: value.applyToDashboard,
				enabled: value.enabled,
				deletedAt: null,
				updatedAt: new Date(),
			};
			// Re-creating a deleted name revives its row, which is what routers
			// that still carry the old reference expect.
			if (taken) {
				await db
					.update(abhashTraefikMiddleware)
					.set(values)
					.where(eq(abhashTraefikMiddleware.id, taken.id));
			} else {
				await db.insert(abhashTraefikMiddleware).values(values);
			}
			const report = await publishMiddlewares(organizationId);
			await audit(ctx, {
				action: "create",
				resourceType: "settings",
				resourceName: `middleware ${value.name}`,
				metadata: { kind: value.config.kind, scope: value.scope },
			});
			return report;
		}),

	update: adminProcedure
		.input(input.extend({ id: z.string() }))
		.mutation(async ({ ctx, input: value }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const row = await findOwn(organizationId, value.id);
			guardDashboard(
				ctx.user.role,
				value.applyToDashboard,
				row.applyToDashboard,
			);
			if (value.name !== row.name) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"A middleware cannot be renamed; routers refer to it by name",
				});
			}
			await db
				.update(abhashTraefikMiddleware)
				.set({
					description: value.description ?? null,
					kind: value.config.kind,
					config: await toStored(value.config, row),
					scope: value.scope,
					projectIds:
						value.scope === "projects"
							? await projectIdsIn(organizationId, value.projectIds)
							: [],
					applyToDashboard: value.applyToDashboard,
					enabled: value.enabled,
					updatedAt: new Date(),
				})
				.where(eq(abhashTraefikMiddleware.id, row.id));
			const report = await publishMiddlewares(organizationId);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: `middleware ${row.name}`,
			});
			return report;
		}),

	setEnabled: adminProcedure
		.input(z.object({ id: z.string(), enabled: z.boolean() }))
		.mutation(async ({ ctx, input: value }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const row = await findOwn(organizationId, value.id);
			await db
				.update(abhashTraefikMiddleware)
				.set({ enabled: value.enabled, updatedAt: new Date() })
				.where(eq(abhashTraefikMiddleware.id, row.id));
			const report = await publishMiddlewares(organizationId);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: `middleware ${row.name}`,
				metadata: { enabled: value.enabled },
			});
			return report;
		}),

	remove: adminProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input: value }) => {
			const organizationId = ctx.session.activeOrganizationId;
			const row = await findOwn(organizationId, value.id);
			guardDashboard(ctx.user.role, false, row.applyToDashboard);
			await db
				.update(abhashTraefikMiddleware)
				.set({ deletedAt: new Date(), updatedAt: new Date() })
				.where(eq(abhashTraefikMiddleware.id, row.id));
			const report = await publishMiddlewares(organizationId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: `middleware ${row.name}`,
			});
			return report;
		}),

	/** Rewrites every server's file and every application router. */
	republish: adminProcedure.mutation(({ ctx }) =>
		publishMiddlewares(ctx.session.activeOrganizationId),
	),
});
