import { execSync } from "node:child_process";
import { db } from "@dokploy/server/db";
import {
	abhashBackupPolicy,
	abhashBackupRepository,
	abhashBackupRun,
	abhashDrillPolicy,
	environments,
	organization,
	postgres,
	projects,
	user,
} from "@dokploy/server/db/schema";
import { runDrill } from "@dokploy/server/services/abhash/backups/drill";
import {
	checkRepository,
	listSnapshots,
	runBackup,
} from "@dokploy/server/services/abhash/backups/service";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Everything here runs against the sandbox Docker daemon, never the host's.
const dockerHost = process.env.SANDBOX_DOCKER_HOST;
const live = dockerHost ? describe : describe.skip;

const suffix = nanoid(8).toLowerCase();
const organizationId = `bk-${suffix}`;
const ownerId = `${organizationId}-owner`;
const appName = `bk-source-${suffix}`;
const repoPath = `/var/backups/abhash-${suffix}`;
let policyId = "";
let drillPolicyId = "";

const docker = (command: string) =>
	execSync(`docker ${command}`, {
		env: { ...process.env, DOCKER_HOST: dockerHost },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

beforeAll(async () => {
	if (!dockerHost) return;
	// A stand-in for a deployed database, labelled the way Swarm labels one.
	docker(
		`run -d --name ${appName} --label com.docker.swarm.service.name=${appName} -e POSTGRES_PASSWORD=source -e POSTGRES_USER=app -e POSTGRES_DB=appdb postgres:16-alpine`,
	);
	for (let attempt = 0; attempt < 60; attempt++) {
		try {
			docker(`exec ${appName} pg_isready -U app -d appdb`);
			break;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}
	}
	docker(
		`exec ${appName} psql -U app -d appdb -c "create table widgets(id int primary key, name text); insert into widgets values (1,'one'),(2,'two');"`,
	);

	await db.insert(user).values({
		id: ownerId,
		email: `${ownerId}@sandbox.test`,
		emailVerified: true,
		expirationDate: new Date().toISOString(),
		createdAt2: new Date().toISOString(),
		updatedAt: new Date(),
	} as never);
	await db.insert(organization).values({
		id: organizationId,
		name: `Backups ${suffix}`,
		ownerId,
		createdAt: new Date(),
	});
	const [project] = await db
		.insert(projects)
		.values({ name: `bk-${suffix}`, organizationId })
		.returning();
	const [environment] = await db
		.insert(environments)
		.values({ name: "production", projectId: project?.projectId as string })
		.returning();
	await db.insert(postgres).values({
		environmentId: environment?.environmentId,
		postgresId: `pg-${suffix}`,
		name: appName,
		appName,
		databaseName: "appdb",
		databaseUser: "app",
		databasePassword: "source",
		dockerImage: "postgres:16-alpine",
		applicationStatus: "done",
		createdAt: new Date().toISOString(),
	} as never);
	const [repository] = await db
		.insert(abhashBackupRepository)
		.values({
			organizationId,
			name: `local-${suffix}`,
			repository: repoPath,
			passwordRef: "drill-repo-password",
		})
		.returning();
	const [policy] = await db
		.insert(abhashBackupPolicy)
		.values({
			organizationId,
			name: `pg-${suffix}`,
			serverId: null,
			targetKind: "postgres",
			target: `pg-${suffix}`,
			repositoryId: repository?.id as string,
			retention: { last: 2, daily: 1, weekly: 0, monthly: 0, yearly: 0 },
		})
		.returning();
	policyId = policy?.id as string;
	const [drill] = await db
		.insert(abhashDrillPolicy)
		.values({
			organizationId,
			policyId,
			where: "isolated-local",
			rtoMinutes: 20,
			queries: [
				{
					name: "Widgets survived",
					sql: "select count(*) from widgets",
					expect: "2",
				},
			],
		})
		.returning();
	drillPolicyId = drill?.id as string;
}, 300_000);

afterAll(async () => {
	if (dockerHost) {
		try {
			docker(`rm -f ${appName}`);
		} catch {
			// Already gone.
		}
	}
	await db.delete(organization).where(eq(organization.id, organizationId));
	await db.delete(user).where(eq(user.id, ownerId));
});

live("backups and drills against a real database", () => {
	it("backs up straight into restic and records the snapshot", async () => {
		const lines: string[] = [];
		const result = await runBackup(
			organizationId,
			policyId,
			(line) => {
				lines.push(line);
			},
			() => {},
		);
		expect(result.snapshotId).toMatch(/^[0-9a-f]{8,}/);
		expect(result.bytesAdded).toBeGreaterThan(0);
		const snapshots = await listSnapshots(organizationId, policyId);
		expect(snapshots.length).toBeGreaterThan(0);
	}, 600_000);

	it("records what was in the database, for the drill to check", async () => {
		const run = await db.query.abhashBackupRun.findFirst({
			where: eq(abhashBackupRun.policyId, policyId),
		});
		expect(run?.stats?.tables).toBe(1);
	});

	it("passes its own integrity check", async () => {
		const result = await checkRepository(organizationId, "", null).catch(
			() => null,
		);
		expect(result).toBeNull();
		const repository = await db.query.abhashBackupRepository.findFirst({
			where: eq(abhashBackupRepository.organizationId, organizationId),
		});
		const checked = await checkRepository(
			organizationId,
			repository?.id as string,
			null,
			100,
		);
		expect(checked.ok).toBe(true);
	}, 300_000);

	it("restores into an isolated copy and verifies it", async () => {
		const outcome = await runDrill(
			organizationId,
			drillPolicyId,
			() => {},
			() => {},
		);
		expect(outcome.status).toBe("passed");
		expect(outcome.rtoSeconds).toBeGreaterThan(0);
		const names = outcome.checks.map((check) => check.name);
		expect(names).toContain("The snapshot restores");
		expect(names).toContain("Widgets survived");
		expect(outcome.checks.every((check) => check.ok)).toBe(true);
	}, 900_000);

	it("leaves nothing behind", () => {
		const containers = docker("ps -a --format '{{.Names}}'");
		expect(containers).not.toMatch(/abhash-drill-/);
		const networks = docker("network ls --format '{{.Name}}'");
		expect(networks).not.toMatch(/abhash-drill-/);
	});

	it("fails the drill when the data does not match", async () => {
		await db
			.update(abhashDrillPolicy)
			.set({
				queries: [
					{
						name: "Impossible",
						sql: "select count(*) from widgets",
						expect: "99",
					},
				],
			})
			.where(eq(abhashDrillPolicy.id, drillPolicyId));
		const outcome = await runDrill(
			organizationId,
			drillPolicyId,
			() => {},
			() => {},
		);
		expect(outcome.status).toBe("failed");
		expect(
			outcome.checks.find((check) => check.name === "Impossible")?.ok,
		).toBe(false);
	}, 900_000);
});
