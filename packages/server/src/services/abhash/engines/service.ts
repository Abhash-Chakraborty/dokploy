import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../../db";
import {
	abhashManagedService,
	compose,
	environments,
} from "../../../db/schema";
import { isFlagEnabled } from "../flags";
import { assertServerInOrganization } from "../ownership";
import { createSecret } from "../vault/secrets";
import { engineById } from "./catalog";
import { attachToDokployNetwork } from "./network";
import type { EngineConfig } from "./types";

export type ManagedServiceRow = typeof abhashManagedService.$inferSelect;

/** URL-safe and shell-safe, so it can sit in a compose env file as-is. */
export const generatePassword = () =>
	randomBytes(24).toString("base64url").slice(0, 32);

const envFile = (env: Record<string, string>) =>
	Object.entries(env)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");

export const listManagedServices = (organizationId: string) =>
	db.query.abhashManagedService.findMany({
		where: eq(abhashManagedService.organizationId, organizationId),
		orderBy: (row, { desc }) => [desc(row.createdAt)],
	});

/**
 * Creates the compose stack for an engine. The generated password goes into
 * the stack's env file, and into the vault as well when it is on, so it can
 * be referenced from other services without copying it around.
 */
export const createManagedService = async (input: {
	organizationId: string;
	environmentId: string;
	engineId: string;
	name: string;
	version?: string;
	config?: EngineConfig;
	serverId?: string | null;
	userId: string | null;
}) => {
	const engine = engineById(input.engineId);
	if (!engine) throw new Error(`Unknown engine: ${input.engineId}`);
	const environment = await db.query.environments.findFirst({
		where: eq(environments.environmentId, input.environmentId),
		with: { project: { columns: { organizationId: true } } },
	});
	if (environment?.project.organizationId !== input.organizationId) {
		throw new Error("Environment not found");
	}
	// The stack is deployed wherever this says, so it must be ours too.
	await assertServerInOrganization(input.organizationId, input.serverId);

	const version = input.version ?? (engine.versions[0] as string);
	if (!engine.versions.includes(version)) {
		throw new Error(`${engine.label} does not offer version ${version}`);
	}
	const password = generatePassword();
	const rendered = engine.render({
		name: input.name,
		version,
		config: input.config ?? {},
		password,
	});

	const [created] = await db
		.insert(compose)
		.values({
			name: input.name,
			appName: `${input.name}-${randomBytes(3).toString("hex")}`,
			environmentId: input.environmentId,
			composeType: "docker-compose",
			sourceType: "raw",
			composeFile: attachToDokployNetwork(rendered.compose, input.name),
			env: envFile(rendered.env),
			serverId: input.serverId ?? null,
			description: `${engine.label} ${version}, managed by Dokploy`,
		} as never)
		.returning();
	if (!created) throw new Error("Could not create the stack");

	const [row] = await db
		.insert(abhashManagedService)
		.values({
			organizationId: input.organizationId,
			environmentId: input.environmentId,
			composeId: created.composeId,
			engine: engine.id,
			version,
			config: input.config ?? {},
			createdBy: input.userId,
		})
		.returning();

	// A copy in the vault, so other services can use ${{secret.NAME}}.
	if (await isFlagEnabled("vault.enabled")) {
		const secretName = `${input.name}_PASSWORD`
			.toUpperCase()
			.replace(/[^A-Z0-9_]/g, "_");
		await createSecret({
			organizationId: input.organizationId,
			name: secretName,
			description: `${engine.label} ${input.name}`,
			scopeType: "environment",
			scopeId: input.environmentId,
			value: password,
			userId: input.userId,
		}).catch(() => null);
	}

	return {
		managed: row,
		composeId: created.composeId,
		connection: rendered.connection,
	};
};

/** Re-renders the stack after a version or setting change. */
export const updateManagedService = async (
	organizationId: string,
	id: string,
	changes: { version?: string; config?: EngineConfig },
) => {
	const row = await db.query.abhashManagedService.findFirst({
		where: and(
			eq(abhashManagedService.id, id),
			eq(abhashManagedService.organizationId, organizationId),
		),
	});
	if (!row) throw new Error("Managed service not found");
	const engine = engineById(row.engine);
	if (!engine) throw new Error(`Unknown engine: ${row.engine}`);
	const stack = await db.query.compose.findFirst({
		where: eq(compose.composeId, row.composeId),
	});
	if (!stack) throw new Error("Its stack is gone");

	const version = changes.version ?? row.version;
	if (!engine.versions.includes(version)) {
		throw new Error(`${engine.label} does not offer version ${version}`);
	}
	const config = { ...row.config, ...(changes.config ?? {}) };
	// Keep the existing credentials: they are already in the env file.
	const existing = Object.fromEntries(
		(stack.env ?? "")
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const index = line.indexOf("=");
				return [line.slice(0, index), line.slice(index + 1)];
			}),
	);
	const rendered = engine.render({
		name: stack.name,
		version,
		config,
		password: "",
	});
	await db
		.update(compose)
		.set({
			composeFile: attachToDokployNetwork(rendered.compose, stack.name),
			env: envFile({ ...rendered.env, ...existing }),
		})
		.where(eq(compose.composeId, stack.composeId));
	await db
		.update(abhashManagedService)
		.set({ version, config, updatedAt: new Date() })
		.where(eq(abhashManagedService.id, row.id));
	return { composeId: stack.composeId, redeploy: true };
};

export const managedServiceFor = (composeId: string) =>
	db.query.abhashManagedService.findFirst({
		where: eq(abhashManagedService.composeId, composeId),
	});
