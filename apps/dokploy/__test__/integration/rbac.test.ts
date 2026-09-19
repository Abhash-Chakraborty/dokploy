import { db } from "@dokploy/server/db";
import {
	abhashRoleBinding,
	abhashTeam,
	abhashTeamMember,
	apikey,
	applications,
	environments,
	member,
	organization,
	organizationRole,
	projects,
	session,
	user,
} from "@dokploy/server/db/schema";
import { setSetting } from "@dokploy/server/services/abhash/flags";
import { syncAllLegacyBindings } from "@dokploy/server/services/abhash/rbac";
import {
	reactivateUser,
	suspendUser,
} from "@dokploy/server/services/abhash/suspension";
import {
	checkEnvironmentAccess,
	checkEnvironmentCreationPermission,
	checkEnvironmentDeletionPermission,
	checkPermission,
	checkProjectAccess,
	checkServiceAccess,
	checkServicePermissionAndAccess,
	findMemberByUserId,
} from "@dokploy/server/services/permission";
import { eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Deterministic PRNG so a failure reproduces.
let seed = 42;
const rand = () => {
	seed = (seed * 1103515245 + 12345) % 2 ** 31;
	return seed / 2 ** 31;
};
const pickSome = <T>(items: T[], p: number) => items.filter(() => rand() < p);

const now = () => new Date().toISOString();
const orgId = `rbac-test-${nanoid(6)}`;
const ownerId = `${orgId}-owner`;
const userIds: string[] = [];

const ctxFor = (userId: string, required?: Record<string, string[]>) => ({
	user: { id: userId },
	session: { activeOrganizationId: orgId },
	...(required ? { abhashRequired: required } : {}),
});

const outcome = async (fn: () => Promise<unknown>) => {
	try {
		await fn();
		return "allow";
	} catch {
		return "deny";
	}
};

const topology = {
	projects: [] as string[],
	environments: [] as { id: string; projectId: string }[],
	services: [] as { id: string; environmentId: string }[],
};

const mkUser = async (id: string) => {
	await db.insert(user).values({
		id,
		email: `${id}@sandbox.test`,
		emailVerified: true,
		expirationDate: now(),
		createdAt2: now(),
		updatedAt: new Date(),
	} as never);
};

beforeAll(async () => {
	await mkUser(ownerId);
	await db.insert(organization).values({
		id: orgId,
		name: "RBAC test",
		ownerId,
		createdAt: new Date(),
	});
	await db.insert(member).values({
		id: nanoid(),
		organizationId: orgId,
		userId: ownerId,
		role: "owner",
		createdAt: new Date(),
	});
	await db.insert(organizationRole).values({
		organizationId: orgId,
		role: "deployer",
		permission: JSON.stringify({
			service: ["read"],
			deployment: ["read", "create"],
			environment: ["read"],
			logs: ["read"],
		}),
	});

	for (let p = 0; p < 3; p++) {
		const projectId = `${orgId}-p${p}`;
		topology.projects.push(projectId);
		await db.insert(projects).values({
			projectId,
			name: `Project ${p}`,
			organizationId: orgId,
			createdAt: now(),
		} as never);
		for (let e = 0; e < 2; e++) {
			const environmentId = `${projectId}-e${e}`;
			topology.environments.push({ id: environmentId, projectId });
			await db.insert(environments).values({
				environmentId,
				name: `env ${e}`,
				projectId,
				createdAt: now(),
			} as never);
			for (let s = 0; s < 2; s++) {
				const applicationId = `${environmentId}-s${s}`;
				topology.services.push({ id: applicationId, environmentId });
				await db.insert(applications).values({
					applicationId,
					name: applicationId,
					appName: applicationId,
					environmentId,
					createdAt: now(),
				} as never);
			}
		}
	}

	const roles = ["member", "member", "member", "deployer", "admin"];
	for (let i = 0; i < 12; i++) {
		const id = `${orgId}-u${i}`;
		userIds.push(id);
		await mkUser(id);
		await db.insert(member).values({
			id: nanoid(),
			organizationId: orgId,
			userId: id,
			role: roles[i % roles.length] as string,
			createdAt: new Date(),
			canCreateProjects: rand() < 0.3,
			canDeleteProjects: rand() < 0.3,
			canCreateServices: rand() < 0.5,
			canDeleteServices: rand() < 0.3,
			canCreateEnvironments: rand() < 0.3,
			canDeleteEnvironments: rand() < 0.3,
			canAccessToDocker: rand() < 0.3,
			accessedProjects: pickSome(topology.projects, 0.5),
			accessedEnvironments: pickSome(
				topology.environments.map((e) => e.id),
				0.4,
			),
			accessedServices: pickSome(
				topology.services.map((s) => s.id),
				0.4,
			),
		} as never);
	}
	await setSetting("rbac.v2", false);
});

afterAll(async () => {
	await setSetting("rbac.v2", false);
	await db.delete(organization).where(eq(organization.id, orgId));
	await db.delete(user).where(inArray(user.id, [ownerId, ...userIds]));
});

/** Every decision the permission engine makes for this org, as a flat map. */
const decisions = async () => {
	const out: Record<string, string> = {};
	for (const userId of userIds) {
		const ctx = ctxFor(userId);
		for (const perm of [
			{ project: ["create"] },
			{ service: ["create"] },
			{ docker: ["read"] },
			{ deployment: ["create"] },
			{ server: ["read"] },
		] as const) {
			out[`${userId} perm ${JSON.stringify(perm)}`] = await outcome(() =>
				checkPermission(ctx, perm as never),
			);
		}
		for (const projectId of topology.projects) {
			out[`${userId} project-delete ${projectId}`] = await outcome(() =>
				checkProjectAccess(ctx, "delete", projectId),
			);
			out[`${userId} service-create ${projectId}`] = await outcome(() =>
				checkServiceAccess(ctx, projectId, "create"),
			);
			out[`${userId} env-create ${projectId}`] = await outcome(() =>
				checkEnvironmentCreationPermission(ctx, projectId),
			);
			out[`${userId} env-delete ${projectId}`] = await outcome(() =>
				checkEnvironmentDeletionPermission(ctx, projectId),
			);
		}
		for (const env of topology.environments) {
			for (const action of ["read", "delete"] as const) {
				out[`${userId} env-${action} ${env.id}`] = await outcome(() =>
					checkEnvironmentAccess(ctx, env.id, action),
				);
			}
		}
		for (const svc of topology.services) {
			for (const action of ["read", "delete"] as const) {
				out[`${userId} svc-${action} ${svc.id}`] = await outcome(() =>
					checkServiceAccess(ctx, svc.id, action),
				);
			}
			out[`${userId} svc-deploy ${svc.id}`] = await outcome(() =>
				checkServicePermissionAndAccess(ctx, svc.id, {
					deployment: ["create"],
				}),
			);
			// A route guarded by withPermission("deployment", "create") that then
			// checks access: legacy checked the permission org-wide.
			out[`${userId} route-deploy ${svc.id}`] = await outcome(async () => {
				const routeCtx = ctxFor(userId, { deployment: ["create"] });
				await checkPermission(routeCtx, { deployment: ["create"] });
				await checkServiceAccess(routeCtx, svc.id, "read");
			});
		}
		const m = await findMemberByUserId(userId, orgId);
		for (const key of [
			"accessedProjects",
			"accessedEnvironments",
			"accessedServices",
		] as const) {
			out[`${userId} ${key}`] = [...m[key]].sort().join(",");
		}
	}
	return out;
};

describe("RBAC v2", () => {
	it("reproduces every legacy decision once the flag is on", async () => {
		const legacy = await decisions();
		await syncAllLegacyBindings();
		await setSetting("rbac.v2", true);
		const v2 = await decisions();
		const diff = Object.keys(legacy).filter((k) => legacy[k] !== v2[k]);
		expect(diff.map((k) => `${k}: ${legacy[k]} -> ${v2[k]}`)).toEqual([]);
		// Guard against a vacuous pass.
		expect(
			Object.values(legacy).filter((v) => v === "allow").length,
		).toBeGreaterThan(50);
		expect(
			Object.values(legacy).filter((v) => v === "deny").length,
		).toBeGreaterThan(50);
	});

	describe("per-project roles through teams", () => {
		const alice = `${orgId}-alice`;
		let teamId = "";
		const [pA, pB] = [
			() => topology.projects[0] as string,
			() => topology.projects[1] as string,
		];
		const serviceIn = (projectId: string) =>
			topology.services.find((s) => s.environmentId.startsWith(projectId))
				?.id as string;

		beforeAll(async () => {
			await setSetting("rbac.v2", true);
			await mkUser(alice);
			userIds.push(alice);
			await db.insert(member).values({
				id: nanoid(),
				organizationId: orgId,
				userId: alice,
				role: "member",
				createdAt: new Date(),
			} as never);
			const [team] = await db
				.insert(abhashTeam)
				.values({ organizationId: orgId, name: "Platform", slug: "platform" })
				.returning();
			teamId = team?.id as string;
			await db.insert(abhashTeamMember).values({ teamId, userId: alice });
			await db.insert(abhashRoleBinding).values([
				{
					organizationId: orgId,
					subjectType: "team",
					subjectId: teamId,
					role: "viewer",
					scopeType: "project",
					scopeId: pA(),
				},
				{
					organizationId: orgId,
					subjectType: "user",
					subjectId: alice,
					role: "developer",
					scopeType: "project",
					scopeId: pB(),
				},
			]);
		});

		it("sees both projects and everything inside them", async () => {
			const m = await findMemberByUserId(alice, orgId);
			expect(new Set(m.accessedProjects)).toEqual(new Set([pA(), pB()]));
			const inside = topology.services
				.filter(
					(s) =>
						s.environmentId.startsWith(pA()) ||
						s.environmentId.startsWith(pB()),
				)
				.map((s) => s.id);
			expect(new Set(m.accessedServices)).toEqual(new Set(inside));
		});

		it("can read in the viewer project but not deploy there", async () => {
			const ctx = ctxFor(alice);
			expect(
				await outcome(() => checkServiceAccess(ctx, serviceIn(pA()), "read")),
			).toBe("allow");
			expect(
				await outcome(() =>
					checkServicePermissionAndAccess(ctx, serviceIn(pA()), {
						deployment: ["create"],
					}),
				),
			).toBe("deny");
		});

		it("can deploy in the developer project", async () => {
			expect(
				await outcome(() =>
					checkServicePermissionAndAccess(ctxFor(alice), serviceIn(pB()), {
						deployment: ["create"],
					}),
				),
			).toBe("allow");
		});

		it("a deploy route cannot borrow the developer grant for the viewer project", async () => {
			const routeCtx = ctxFor(alice, { deployment: ["create"] });
			expect(
				await outcome(() =>
					checkPermission(routeCtx, { deployment: ["create"] }),
				),
			).toBe("allow");
			expect(
				await outcome(() =>
					checkServiceAccess(routeCtx, serviceIn(pA()), "read"),
				),
			).toBe("deny");
			expect(
				await outcome(() =>
					checkServiceAccess(routeCtx, serviceIn(pB()), "read"),
				),
			).toBe("allow");
		});

		it("cannot see or act on a project with no grant", async () => {
			const pC = topology.projects[2] as string;
			expect(
				await outcome(() =>
					checkServiceAccess(ctxFor(alice), serviceIn(pC), "read"),
				),
			).toBe("deny");
		});

		it("developer cannot delete the project or reach org-level resources", async () => {
			const ctx = ctxFor(alice);
			expect(await outcome(() => checkProjectAccess(ctx, "delete", pB()))).toBe(
				"deny",
			);
			expect(
				await outcome(() => checkPermission(ctx, { server: ["create"] })),
			).toBe("deny");
			expect(
				await outcome(() => checkPermission(ctx, { member: ["update"] })),
			).toBe("deny");
		});

		it("leaving the team removes the team's grant", async () => {
			await db
				.delete(abhashTeamMember)
				.where(eq(abhashTeamMember.teamId, teamId));
			expect(
				await outcome(() =>
					checkServiceAccess(ctxFor(alice), serviceIn(pA()), "read"),
				),
			).toBe("deny");
		});

		it("deleting a service drops grants on it", async () => {
			const svc = serviceIn(pB());
			await db.insert(abhashRoleBinding).values({
				organizationId: orgId,
				subjectType: "user",
				subjectId: alice,
				role: "viewer",
				scopeType: "service",
				scopeId: svc,
			});
			await db.delete(applications).where(eq(applications.applicationId, svc));
			const left = await db.query.abhashRoleBinding.findMany({
				where: eq(abhashRoleBinding.scopeId, svc),
			});
			expect(left).toEqual([]);
		});
	});

	describe("suspension", () => {
		const bob = `${orgId}-bob`;

		beforeAll(async () => {
			await mkUser(bob);
			userIds.push(bob);
			await db.insert(member).values({
				id: nanoid(),
				organizationId: orgId,
				userId: bob,
				role: "admin",
				createdAt: new Date(),
			} as never);
			await db.insert(session).values({
				id: `${bob}-s`,
				token: `${bob}-token`,
				userId: bob,
				expiresAt: new Date(Date.now() + 3600_000),
				createdAt: new Date(),
				updatedAt: new Date(),
			} as never);
			await db.insert(apikey).values([
				{
					id: `${bob}-k1`,
					key: "k1",
					referenceId: bob,
					enabled: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
				{
					id: `${bob}-k2`,
					key: "k2",
					referenceId: bob,
					enabled: false,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			] as never);
		});

		it("blocks the user, ends sessions and disables their keys", async () => {
			await suspendUser({ userId: bob, actorId: ownerId, source: "manual" });
			expect(
				await outcome(() => checkPermission(ctxFor(bob), { docker: ["read"] })),
			).toBe("deny");
			expect(
				await db.query.session.findMany({ where: eq(session.userId, bob) }),
			).toEqual([]);
			const keys = await db.query.apikey.findMany({
				where: eq(apikey.referenceId, bob),
			});
			expect(keys.every((k) => k.enabled === false)).toBe(true);
		});

		it("reactivation restores only the keys it disabled", async () => {
			await reactivateUser({ userId: bob, actorId: ownerId });
			expect(
				await outcome(() => checkPermission(ctxFor(bob), { docker: ["read"] })),
			).toBe("allow");
			const keys = await db.query.apikey.findMany({
				where: eq(apikey.referenceId, bob),
			});
			expect(Object.fromEntries(keys.map((k) => [k.id, k.enabled]))).toEqual({
				[`${bob}-k1`]: true,
				[`${bob}-k2`]: false,
			});
		});

		it("refuses to suspend an owner or yourself", async () => {
			await expect(
				suspendUser({ userId: ownerId, actorId: bob, source: "manual" }),
			).rejects.toThrow(/owner/);
			await expect(
				suspendUser({ userId: bob, actorId: bob, source: "manual" }),
			).rejects.toThrow(/yourself/);
		});
	});
});

describe("app-name access", () => {
	it("resolves exact app names and compose container names within the org", async () => {
		const { findServiceByAppName } = await import(
			"@dokploy/server/services/abhash/app-access"
		);
		const svc = topology.services[0]?.id as string;
		expect(await findServiceByAppName(svc, orgId)).toBe(svc);
		expect(await findServiceByAppName(`${svc}-web-1`, orgId)).toBe(svc);
		expect(await findServiceByAppName(`${svc}x`, orgId)).toBeNull();
		expect(await findServiceByAppName(svc, "another-org")).toBeNull();
	});
});
