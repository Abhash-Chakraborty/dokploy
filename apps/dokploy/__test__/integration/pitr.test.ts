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
	configureArchiving,
	disableWal,
	prepareArchive,
	recoverToPointInTime,
	recoveryWindow,
	replaceDataCommand,
	shipWal,
} from "@dokploy/server/services/abhash/backups/pitr";
import {
	findPolicy,
	listSnapshots,
	runBackup,
} from "@dokploy/server/services/abhash/backups/service";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Everything here runs against the sandbox Docker daemon, never the host's.
const dockerHost = process.env.SANDBOX_DOCKER_HOST;
const live = dockerHost ? describe : describe.skip;

const suffix = nanoid(8)
	.toLowerCase()
	.replace(/[^a-z0-9]/g, "x");
const organizationId = `pitr-${suffix}`;
const ownerId = `${organizationId}-owner`;
const appName = `pitr-source-${suffix}`;
const repoPath = `/var/backups/abhash-pitr-${suffix}`;
let policyId = "";
let keptVolume = "";
let between = "";

const docker = (command: string) =>
	execSync(`docker ${command}`, {
		env: { ...process.env, DOCKER_HOST: dockerHost },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

const sql = (statement: string) =>
	docker(
		`exec ${appName} psql -X -U app -d appdb -tAc "${statement.replace(/"/g, '\\"')}"`,
	).trim();

const waitForSource = async () => {
	for (let attempt = 0; ; attempt++) {
		try {
			sql("select 1");
			return;
		} catch (error) {
			if (attempt === 59) throw error;
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}
	}
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quiet = () => {};

beforeAll(async () => {
	if (!dockerHost) return;
	// A stand-in for a deployed database: labelled the way Swarm labels one,
	// with the data and WAL volumes a deployed service would have.
	docker(
		`run -d --name ${appName} --label com.docker.swarm.service.name=${appName} -v ${appName}-data:/var/lib/postgresql/data -v ${appName}-wal:/wal-archive -e POSTGRES_PASSWORD=source -e POSTGRES_USER=app -e POSTGRES_DB=appdb postgres:16-alpine`,
	);
	await waitForSource();
	// The image restarts once after initialising; wait for the real server.
	await pause(3000);
	await waitForSource();

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
		name: `PITR ${suffix}`,
		ownerId,
		createdAt: new Date(),
	});
	const [project] = await db
		.insert(projects)
		.values({ name: `pitr-${suffix}`, organizationId })
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
			passwordRef: "pitr-repo-password",
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
			retention: { last: 1, daily: 0, weekly: 0, monthly: 0, yearly: 0 },
		})
		.returning();
	policyId = policy?.id as string;
}, 300_000);

afterAll(async () => {
	if (dockerHost) {
		for (const command of [
			`rm -f ${appName}`,
			`volume rm ${appName}-data ${appName}-wal`,
			"volume rm $(docker volume ls -q --filter label=com.abhash.pitr=1)",
		]) {
			try {
				docker(command);
			} catch {
				// Already gone.
			}
		}
	}
	await db.delete(organization).where(eq(organization.id, organizationId));
	await db.delete(user).where(eq(user.id, ownerId));
});

live("WAL archiving and point-in-time recovery", () => {
	it("turns archiving on, which needs one restart to take effect", async () => {
		const { policy } = await findPolicy(organizationId, policyId);
		const configured = await configureArchiving(policy);
		expect(configured.restartNeeded).toBe(true);

		docker(`restart ${appName}`);
		await waitForSource();
		await prepareArchive(policy);
		await db
			.update(abhashBackupPolicy)
			.set({ walEnabled: true })
			.where(eq(abhashBackupPolicy.id, policyId));

		expect(sql("show archive_mode")).toBe("on");
		// Running it again changes nothing and asks for no restart.
		expect((await configureArchiving(policy)).restartNeeded).toBe(false);
	}, 300_000);

	it("takes a physical base backup once archiving is on", async () => {
		sql("create table events(id serial primary key, name text)");
		sql("insert into events(name) values ('before')");
		const result = await runBackup(organizationId, policyId, quiet, quiet);
		const run = await db.query.abhashBackupRun.findFirst({
			where: eq(abhashBackupRun.id, result.runId),
		});
		expect(run?.method).toBe("base");
		expect(run?.walStart).toMatch(/^[0-9A-F]{24}$/);
	}, 600_000);

	it("ships WAL without its snapshots showing up as backups", async () => {
		sql("insert into events(name) values ('kept')");
		await pause(2000);
		// The database's clock, not this machine's: recovery compares against
		// commit times that Postgres stamped.
		between = new Date(
			Number(sql("select (extract(epoch from now()) * 1000)::bigint")),
		).toISOString();
		await pause(2000);
		sql("insert into events(name) values ('lost')");

		const shipped = await shipWal(organizationId, policyId, quiet, quiet, {
			switchSegment: true,
		});
		expect(shipped.snapshotId).toMatch(/^[0-9a-f]{64}$/);
		expect(shipped.problem).toBeNull();

		const { policy } = await findPolicy(organizationId, policyId);
		expect(policy.walStatus?.archiveMode).toBe("on");
		expect(policy.walStatus?.lastArchivedWal).toMatch(/^[0-9A-F]{24}$/);
		// Base-backup retention must never see, and so never delete, WAL.
		const backups = await listSnapshots(organizationId, policyId);
		expect(backups).toHaveLength(1);
		expect(backups[0]?.tags).toContain("base");
	}, 600_000);

	it("recovers to a moment between two writes, exactly", async () => {
		let names = "";
		const outcome = await recoverToPointInTime(
			organizationId,
			policyId,
			{
				targetTime: between,
				keepVolume: true,
				verify: async (query) => {
					names = (
						await query("select string_agg(name, ',' order by id) from events")
					).value;
				},
			},
			quiet,
			quiet,
		);
		expect(names).toBe("before,kept");
		expect(outcome.checks.every((check) => check.ok)).toBe(true);
		expect(outcome.volume).toMatch(/^abhash-pitr-/);
		keptVolume = outcome.volume as string;
		expect(docker("volume ls -q")).toContain(keptVolume);
		// The copy itself is gone: nothing of it may keep running.
		expect(docker("ps -a --format '{{.Names}}'")).not.toContain("abhash-pitr-");
		// And the live database never noticed.
		expect(sql("select count(*) from events")).toBe("3");
	}, 900_000);

	it("recovers to the latest moment when no time is given", async () => {
		let names = "";
		const outcome = await recoverToPointInTime(
			organizationId,
			policyId,
			{
				targetTime: null,
				keepVolume: false,
				verify: async (query) => {
					names = (
						await query("select string_agg(name, ',' order by id) from events")
					).value;
				},
			},
			quiet,
			quiet,
		);
		expect(names).toBe("before,kept,lost");
		expect(outcome.volume).toBeNull();
	}, 900_000);

	it("refuses targets it cannot reach, and leaves nothing behind", async () => {
		const volumesBefore = docker("volume ls -q").split("\n").length;
		await expect(
			recoverToPointInTime(
				organizationId,
				policyId,
				{
					targetTime: new Date(Date.now() + 3_600_000).toISOString(),
					keepVolume: true,
				},
				quiet,
				quiet,
			),
		).rejects.toThrow(/future/);
		await expect(
			recoverToPointInTime(
				organizationId,
				policyId,
				{ targetTime: "2001-01-01T00:00:00.000Z", keepVolume: true },
				quiet,
				quiet,
			),
		).rejects.toThrow(/no base backup from before/);
		expect(docker("volume ls -q").split("\n").length).toBe(volumesBefore);
	}, 300_000);

	it("reports the window a target can be picked from", async () => {
		const window = await recoveryWindow(organizationId, policyId);
		expect(window.earliest).toBeInstanceOf(Date);
		expect(window.latest?.getTime()).toBeGreaterThanOrEqual(
			window.earliest?.getTime() as number,
		);
	});

	it("still ships and recovers with the database down", async () => {
		sql("insert into events(name) values ('last words')");
		sql("select pg_switch_wal()");
		await pause(3000);
		docker(`stop ${appName}`);

		const shipped = await shipWal(organizationId, policyId, quiet, quiet);
		expect(shipped.problem).toMatch(/did not answer/);

		let names = "";
		await recoverToPointInTime(
			organizationId,
			policyId,
			{
				targetTime: null,
				keepVolume: false,
				verify: async (query) => {
					names = (
						await query("select string_agg(name, ',' order by id) from events")
					).value;
				},
			},
			quiet,
			quiet,
		);
		expect(names).toBe("before,kept,lost,last words");
	}, 900_000);

	it("swaps a recovered volume in, keeping the old data and the archive", async () => {
		const safetyVolume = `${appName}-before-pitr`;
		execSync(
			replaceDataCommand({
				recoveredVolume: keptVolume,
				liveVolume: `${appName}-data`,
				dataSubpath: "",
				safetyVolume,
				walVolume: `${appName}-wal`,
			}),
			{
				env: { ...process.env, DOCKER_HOST: dockerHost },
				shell: "/bin/sh",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		docker(`start ${appName}`);
		await waitForSource();

		expect(sql("select string_agg(name, ',' order by id) from events")).toBe(
			"before,kept",
		);
		// The recovery block is gone, so the live database archives again,
		// now on the timeline the recovery started.
		expect(sql("show archive_mode")).toBe("on");
		sql("insert into events(name) values ('after recovery')");
		const shipped = await shipWal(organizationId, policyId, quiet, quiet, {
			switchSegment: true,
		});
		expect(shipped.problem).toBeNull();
		const { policy } = await findPolicy(organizationId, policyId);
		expect(policy.walStatus?.lastArchivedWal?.slice(0, 8)).toBe("00000002");
		expect(docker("volume ls -q")).toContain(safetyVolume);
		docker(`volume rm ${safetyVolume} ${keptVolume}`);
	}, 600_000);

	it("prunes the local archive only once a newer base makes it safe", async () => {
		const before = docker(
			`run --rm -v ${appName}-wal:/w:ro alpine:3.20 ls -1 /w/wal`,
		)
			.trim()
			.split("\n");
		expect(before.some((file) => file.startsWith("00000001"))).toBe(true);

		await runBackup(organizationId, policyId, quiet, quiet);
		// Straight after the base nothing may go: the grace period is what
		// guarantees a snapshot holding both the old WAL and the new base.
		const early = await shipWal(organizationId, policyId, quiet, quiet);
		expect(early.pruned).toBe(0);

		const newest = await db.query.abhashBackupRun.findFirst({
			where: eq(abhashBackupRun.policyId, policyId),
			orderBy: [desc(abhashBackupRun.startedAt)],
		});
		await db
			.update(abhashBackupRun)
			.set({ finishedAt: new Date(Date.now() - 10 * 60_000) })
			.where(eq(abhashBackupRun.id, newest?.id as string));
		// The earlier ship is now old enough to be the proof pruning waits for.
		const late = await shipWal(organizationId, policyId, quiet, quiet);
		expect(late.pruned).toBeGreaterThan(0);
		// And there is nothing left to take the time after.
		const again = await shipWal(organizationId, policyId, quiet, quiet);
		expect(again.pruned).toBe(0);

		const after = docker(
			`run --rm -v ${appName}-wal:/w:ro alpine:3.20 ls -1 /w/wal`,
		)
			.trim()
			.split("\n");
		expect(after.some((file) => file.startsWith("00000001"))).toBe(false);
		// Timeline history is tiny and always needed.
		expect(after).toContain("00000002.history.gz");
	}, 900_000);

	it("drills by really recovering, and notices a wrong answer", async () => {
		const [drill] = await db
			.insert(abhashDrillPolicy)
			.values({
				organizationId,
				policyId,
				where: "isolated-local",
				rtoMinutes: 20,
				queries: [
					{
						name: "Events survived",
						sql: "select count(*) from events",
						expect: "3",
					},
				],
			})
			.returning();
		const passed = await runDrill(
			organizationId,
			drill?.id as string,
			quiet,
			quiet,
		);
		expect(passed.status).toBe("passed");
		expect(passed.checks.map((check) => check.name)).toContain(
			"The WAL is unbroken",
		);

		await db
			.update(abhashDrillPolicy)
			.set({
				queries: [
					{
						name: "Impossible",
						sql: "select count(*) from events",
						expect: "99",
					},
				],
			})
			.where(eq(abhashDrillPolicy.id, drill?.id as string));
		const failed = await runDrill(
			organizationId,
			drill?.id as string,
			quiet,
			quiet,
		);
		expect(failed.status).toBe("failed");
	}, 1_200_000);

	it("turns off without leaving Postgres hoarding WAL", async () => {
		await disableWal(organizationId, policyId);
		const { policy } = await findPolicy(organizationId, policyId);
		expect(policy.walEnabled).toBe(false);
		// archive_mode stays on until a restart; a command that always
		// succeeds is what lets segments be recycled in the meantime.
		expect(sql("show archive_command")).toBe("/bin/true");
		await expect(
			shipWal(organizationId, policyId, quiet, quiet),
		).rejects.toThrow(/off/);
	}, 120_000);
});
