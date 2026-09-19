import { db } from "@dokploy/server/db";
import {
	abhashSecret,
	account,
	environments,
	projects,
} from "@dokploy/server/db/schema";
import {
	getSetting,
	isFlagEnabled,
	setSetting,
} from "@dokploy/server/services/abhash/flags";
import { enqueueJob } from "@dokploy/server/services/abhash/jobs";
import {
	convertCredentials,
	createKeyring,
	createSecret,
	exportRecoveryKit,
	hasKeyring,
	importRecoveryKit,
	keyringIds,
	listSecretVersions,
	readSecretValue,
	restoreSecretVersion,
	rotateMasterKey,
	SECRET_NAME,
	secretUsages,
	setCredentialEncryptionEnabled,
	setSecretValue,
} from "@dokploy/server/services/abhash/vault";
import { findMemberByUserId } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import bcrypt from "bcrypt";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
} from "../../trpc";

type Ctx = {
	user: { id: string; role: string; email: string };
	session: { activeOrganizationId: string };
};

const scopeInput = z.object({
	scopeType: z.enum(["organization", "project", "environment"]),
	scopeId: z.string().optional(),
});

const isAdmin = (ctx: Ctx) =>
	ctx.user.role === "owner" || ctx.user.role === "admin";

const ownerOnly = (ctx: Ctx) => {
	if (ctx.user.role !== "owner") {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Only the organization owner can do this",
		});
	}
};

const asTrpc = (error: unknown) =>
	new TRPCError({
		code: "BAD_REQUEST",
		message: error instanceof Error ? error.message : String(error),
	});

/** Scopes the caller may read or write secrets in. */
const reachableScopes = async (ctx: Ctx) => {
	const organizationId = ctx.session.activeOrganizationId;
	if (isAdmin(ctx)) return "all" as const;
	const me = await findMemberByUserId(ctx.user.id, organizationId);
	const projectIds = me?.accessedProjects ?? [];
	const environmentIds = me?.accessedEnvironments ?? [];
	// Environments the member reaches through a project they can see.
	const inherited = projectIds.length
		? await db.query.environments.findMany({
				where: inArray(environments.projectId, projectIds),
				columns: { environmentId: true },
			})
		: [];
	return {
		projectIds,
		environmentIds: [
			...new Set([...environmentIds, ...inherited.map((e) => e.environmentId)]),
		],
	};
};

const resolveScope = async (
	ctx: Ctx,
	input: z.infer<typeof scopeInput>,
	write: boolean,
) => {
	const organizationId = ctx.session.activeOrganizationId;
	if (input.scopeType === "organization") {
		if (write && !isAdmin(ctx)) {
			throw new TRPCError({
				code: "FORBIDDEN",
				message: "Only admins can add organization-wide secrets",
			});
		}
		return organizationId;
	}
	const scopeId = input.scopeId;
	if (!scopeId) {
		throw new TRPCError({ code: "BAD_REQUEST", message: "Pick a scope" });
	}
	const owner =
		input.scopeType === "project"
			? await db.query.projects.findFirst({
					where: and(
						eq(projects.projectId, scopeId),
						eq(projects.organizationId, organizationId),
					),
					columns: { projectId: true },
				})
			: await db.query.environments.findFirst({
					where: eq(environments.environmentId, scopeId),
					with: { project: { columns: { organizationId: true } } },
				});
	const belongs =
		input.scopeType === "project"
			? !!owner
			: (owner as { project?: { organizationId: string } } | undefined)?.project
					?.organizationId === organizationId;
	if (!belongs) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Scope not found" });
	}
	const reachable = await reachableScopes(ctx);
	if (reachable !== "all") {
		const ok =
			input.scopeType === "project"
				? reachable.projectIds.includes(scopeId)
				: reachable.environmentIds.includes(scopeId);
		if (!ok) {
			throw new TRPCError({
				code: "FORBIDDEN",
				message: "No access to that scope",
			});
		}
	}
	return scopeId;
};

const visibleSecret = async (ctx: Ctx, id: string) => {
	const secret = await db.query.abhashSecret.findFirst({
		where: and(
			eq(abhashSecret.id, id),
			eq(abhashSecret.organizationId, ctx.session.activeOrganizationId),
		),
	});
	if (!secret) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Secret not found" });
	}
	const reachable = await reachableScopes(ctx);
	if (reachable === "all" || secret.scopeType === "organization") return secret;
	const ok =
		secret.scopeType === "project"
			? reachable.projectIds.includes(secret.scopeId)
			: reachable.environmentIds.includes(secret.scopeId);
	if (!ok) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Secret not found" });
	}
	return secret;
};

/** Revealing a value asks for the password again, and is always audited. */
const assertPassword = async (ctx: Ctx, password: string) => {
	const credential = await db.query.account.findFirst({
		where: and(
			eq(account.userId, ctx.user.id),
			eq(account.providerId, "credential"),
		),
		columns: { password: true },
	});
	const hash = credential?.password;
	if (!hash) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message:
				"Revealing a value needs a password on this account; owners signing in with SSO can export a recovery kit instead",
		});
	}
	// Dokploy hashes passwords with bcrypt (see lib/auth.ts), not Better
	// Auth's default hasher.
	if (!bcrypt.compareSync(password, hash)) {
		throw new TRPCError({ code: "FORBIDDEN", message: "Wrong password" });
	}
};

export const abhashVaultRouter = createTRPCRouter({
	status: protectedProcedure.query(async ({ ctx }) => ({
		enabled: await isFlagEnabled("vault.enabled"),
		keyReady: hasKeyring(),
		keyIds: isAdmin(ctx) ? keyringIds() : [],
		canReveal: ctx.user.role === "owner",
		credentialsEncrypted: await getSetting("vault.encryptCredentials", false),
	})),

	/**
	 * Encrypts the credentials upstream stores in plain text (SSH keys, S3
	 * keys, registry and git tokens, database passwords). Switching it off
	 * converts them back, which is what keeps a rollback to the previous
	 * image possible.
	 */
	setCredentialEncryption: adminProcedure
		.input(z.object({ enabled: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			ownerOnly(ctx);
			await audit(ctx, {
				action: "update",
				resourceType: "featureFlag",
				resourceName: "vault.encryptCredentials",
				metadata: input,
			});
			if (await isFlagEnabled("jobs.enabled")) {
				const job = await enqueueJob(
					"vault.convert-credentials",
					{ enabled: input.enabled, userId: ctx.user.id },
					{
						actor: { type: "user", id: ctx.user.id, name: ctx.user.email },
						organizationId: ctx.session.activeOrganizationId,
					},
				).catch(() => null);
				if (job) return { jobId: job.id, changed: null };
			}
			const changed = await setCredentialEncryptionEnabled(
				input.enabled,
				ctx.user.id,
			);
			return { jobId: null, changed };
		}),

	/** Re-runs the conversion, for rows written while it was interrupted. */
	reconvertCredentials: adminProcedure.mutation(async ({ ctx }) => {
		ownerOnly(ctx);
		const enabled = await getSetting("vault.encryptCredentials", false);
		return {
			changed: await convertCredentials(enabled ? "encrypt" : "decrypt"),
		};
	}),

	setEnabled: adminProcedure
		.input(z.object({ enabled: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			ownerOnly(ctx);
			if (input.enabled) createKeyring();
			await setSetting("vault.enabled", input.enabled, ctx.user.id);
			await audit(ctx, {
				action: "update",
				resourceType: "featureFlag",
				resourceName: "vault.enabled",
				metadata: input,
			});
			return { keyReady: hasKeyring() };
		}),

	exportRecoveryKit: adminProcedure
		.input(z.object({ passphrase: z.string().min(12).max(256) }))
		.mutation(async ({ ctx, input }) => {
			ownerOnly(ctx);
			await audit(ctx, {
				action: "create",
				resourceType: "security",
				resourceName: "vault-recovery-kit",
			});
			try {
				return exportRecoveryKit(input.passphrase);
			} catch (error) {
				throw asTrpc(error);
			}
		}),

	importRecoveryKit: adminProcedure
		.input(
			z.object({
				kit: z.string().max(100_000),
				passphrase: z.string().min(1).max(256),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			ownerOnly(ctx);
			try {
				const restored = importRecoveryKit(
					JSON.parse(input.kit),
					input.passphrase,
				);
				await audit(ctx, {
					action: "restore",
					resourceType: "security",
					resourceName: "vault-recovery-kit",
					metadata: { keyIds: restored },
				});
				return { keyIds: restored };
			} catch (error) {
				throw asTrpc(error);
			}
		}),

	rotateKey: adminProcedure.mutation(async ({ ctx }) => {
		ownerOnly(ctx);
		try {
			const result = await rotateMasterKey();
			await audit(ctx, {
				action: "update",
				resourceType: "security",
				resourceName: "vault-master-key",
				metadata: result,
			});
			return result;
		} catch (error) {
			throw asTrpc(error);
		}
	}),

	list: protectedProcedure.query(async ({ ctx }) => {
		const organizationId = ctx.session.activeOrganizationId;
		const reachable = await reachableScopes(ctx);
		const where =
			reachable === "all"
				? eq(abhashSecret.organizationId, organizationId)
				: and(
						eq(abhashSecret.organizationId, organizationId),
						or(
							eq(abhashSecret.scopeType, "organization"),
							...(reachable.projectIds.length
								? [
										and(
											eq(abhashSecret.scopeType, "project"),
											inArray(abhashSecret.scopeId, reachable.projectIds),
										),
									]
								: []),
							...(reachable.environmentIds.length
								? [
										and(
											eq(abhashSecret.scopeType, "environment"),
											inArray(abhashSecret.scopeId, reachable.environmentIds),
										),
									]
								: []),
						),
					);
		const secrets = await db.query.abhashSecret.findMany({
			where,
			orderBy: [asc(abhashSecret.name)],
		});
		// Scope labels, so the table can show where a secret lives.
		const projectRows = await db.query.projects.findMany({
			where: eq(projects.organizationId, organizationId),
			columns: { projectId: true, name: true },
			with: {
				environments: { columns: { environmentId: true, name: true } },
			},
		});
		const labels = new Map<string, string>();
		for (const project of projectRows) {
			labels.set(project.projectId, project.name);
			for (const environment of project.environments) {
				labels.set(
					environment.environmentId,
					`${project.name} / ${environment.name}`,
				);
			}
		}
		return secrets.map((secret) => ({
			...secret,
			scopeLabel:
				secret.scopeType === "organization"
					? "Organization"
					: (labels.get(secret.scopeId) ?? "Unknown"),
		}));
	}),

	scopes: protectedProcedure.query(async ({ ctx }) => {
		const reachable = await reachableScopes(ctx);
		const rows = await db.query.projects.findMany({
			where: eq(projects.organizationId, ctx.session.activeOrganizationId),
			columns: { projectId: true, name: true },
			with: { environments: { columns: { environmentId: true, name: true } } },
		});
		return rows
			.filter(
				(p) =>
					reachable === "all" || reachable.projectIds.includes(p.projectId),
			)
			.map((p) => ({
				projectId: p.projectId,
				name: p.name,
				environments: p.environments,
			}));
	}),

	create: protectedProcedure
		.input(
			z.object({
				name: z.string().trim().regex(SECRET_NAME, "Use UPPER_SNAKE_CASE"),
				description: z.string().trim().max(500).default(""),
				value: z.string().min(1),
				tags: z.array(z.string().trim().min(1).max(40)).default([]),
				expiresAt: z.string().datetime().nullable().default(null),
				rotateEveryDays: z
					.number()
					.int()
					.min(1)
					.max(3650)
					.nullable()
					.default(null),
				scopeType: z.enum(["organization", "project", "environment"]),
				scopeId: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			if (!(await isFlagEnabled("vault.enabled"))) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "Turn the vault on first",
				});
			}
			const scopeId = await resolveScope(ctx, input, true);
			try {
				const secret = await createSecret({
					organizationId: ctx.session.activeOrganizationId,
					name: input.name,
					description: input.description,
					scopeType: input.scopeType,
					scopeId,
					tags: input.tags,
					value: input.value,
					expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
					rotateEveryDays: input.rotateEveryDays,
					userId: ctx.user.id,
				});
				await audit(ctx, {
					action: "create",
					resourceType: "secret",
					resourceId: secret.id,
					resourceName: secret.name,
					metadata: { scopeType: secret.scopeType, scopeId: secret.scopeId },
				});
				return { id: secret.id, name: secret.name };
			} catch (error) {
				throw asTrpc(error);
			}
		}),

	update: protectedProcedure
		.input(
			z.object({
				id: z.string(),
				description: z.string().trim().max(500),
				tags: z.array(z.string().trim().min(1).max(40)),
				expiresAt: z.string().datetime().nullable(),
				rotateEveryDays: z.number().int().min(1).max(3650).nullable(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const secret = await visibleSecret(ctx, input.id);
			await db
				.update(abhashSecret)
				.set({
					description: input.description,
					tags: input.tags,
					expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
					rotateEveryDays: input.rotateEveryDays,
					updatedBy: ctx.user.id,
					updatedAt: new Date(),
				})
				.where(eq(abhashSecret.id, secret.id));
			await audit(ctx, {
				action: "update",
				resourceType: "secret",
				resourceId: secret.id,
				resourceName: secret.name,
			});
			return true;
		}),

	setValue: protectedProcedure
		.input(z.object({ id: z.string(), value: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const secret = await visibleSecret(ctx, input.id);
			try {
				const version = await setSecretValue(secret, input.value, ctx.user.id);
				await audit(ctx, {
					action: "update",
					resourceType: "secret",
					resourceId: secret.id,
					resourceName: secret.name,
					metadata: { version },
				});
				return { version };
			} catch (error) {
				throw asTrpc(error);
			}
		}),

	versions: protectedProcedure
		.input(z.object({ id: z.string() }))
		.query(async ({ ctx, input }) => {
			const secret = await visibleSecret(ctx, input.id);
			return {
				versions: await listSecretVersions(secret.id),
				usages: await secretUsages(secret.id),
			};
		}),

	restoreVersion: protectedProcedure
		.input(z.object({ id: z.string(), version: z.number().int().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const secret = await visibleSecret(ctx, input.id);
			try {
				const version = await restoreSecretVersion(
					secret,
					input.version,
					ctx.user.id,
				);
				await audit(ctx, {
					action: "restore",
					resourceType: "secret",
					resourceId: secret.id,
					resourceName: secret.name,
					metadata: { restoredFrom: input.version, version },
				});
				return { version };
			} catch (error) {
				throw asTrpc(error);
			}
		}),

	reveal: protectedProcedure
		.input(z.object({ id: z.string(), password: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			ownerOnly(ctx);
			const secret = await visibleSecret(ctx, input.id);
			await assertPassword(ctx, input.password);
			await audit(ctx, {
				action: "run",
				resourceType: "secret",
				resourceId: secret.id,
				resourceName: secret.name,
				metadata: { note: "Value revealed" },
			});
			try {
				return { value: await readSecretValue(secret) };
			} catch (error) {
				throw asTrpc(error);
			}
		}),

	remove: adminProcedure
		.input(z.object({ id: z.string(), force: z.boolean().default(false) }))
		.mutation(async ({ ctx, input }) => {
			const secret = await visibleSecret(ctx, input.id);
			const usages = await secretUsages(secret.id);
			if (usages.length && !input.force) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: `${secret.name} was used by ${usages.length} environment(s) at the last deploy. Delete anyway to remove it.`,
				});
			}
			await db.delete(abhashSecret).where(eq(abhashSecret.id, secret.id));
			await audit(ctx, {
				action: "delete",
				resourceType: "secret",
				resourceId: secret.id,
				resourceName: secret.name,
				metadata: { usages: usages.length },
			});
			return true;
		}),
});
