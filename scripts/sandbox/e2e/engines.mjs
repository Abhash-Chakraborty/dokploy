// Databases and services end to end: every engine in the catalogue is
// created, deployed into the sandbox daemon, and must stay up (and healthy,
// where it has a health check) and be reachable from another container on
// dokploy-network at the address the UI advertises.
//   ENGINES=valkey,nats  node scripts/sandbox/e2e/engines.mjs   (a subset)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { runChecks, signInOwner, sql, trpc } from "./lib.mjs";

assert.ok(
	process.env.DOCKER_HOST?.startsWith("tcp://127.0.0.1:"),
	"run through sandbox.sh exec so stacks land in the sandbox daemon",
);
const owner = await signInOwner();
const { check, finish } = runChecks();
const suffix = Date.now().toString(36).slice(-4);
const docker = (...args) =>
	execFileSync("docker", args, { encoding: "utf8", stdio: "pipe" }).trim();

const catalog = await trpc("engines.catalog", null, owner, "query");
assert.ok(catalog.ok, catalog.error);
const wanted = (process.env.ENGINES ?? "").split(",").filter(Boolean);
const engines = (catalog.data.engines ?? catalog.data).filter(
	(engine) => wanted.length === 0 || wanted.includes(engine.id),
);

const project = await trpc(
	"project.create",
	{ name: `engines-${suffix}` },
	owner,
);
assert.ok(project.ok, project.error);
const projectId = project.data.project?.projectId ?? project.data.projectId;
const one = await trpc("project.one", { projectId }, owner, "query");
const environmentId = one.data.environments[0].environmentId;

// Settle time: JVM engines and a three-member replica set take a while.
const settleMs = (id) =>
	["opensearch", "kafka", "clickhouse", "mongo-replicaset"].includes(id)
		? 90_000
		: 40_000;

const deploy = async (engine) => {
	const name = `${engine.id.replace(/[^a-z0-9-]/g, "-")}-${suffix}`;
	const created = await trpc(
		"engines.create",
		{ engineId: engine.id, environmentId, name },
		owner,
	);
	assert.ok(created.ok, created.error);
	const { composeId } = created.data;
	const queued = await trpc("compose.deploy", { composeId }, owner);
	assert.ok(queued.ok, queued.error);
	for (let i = 0; i < 150; i++) {
		const [row] =
			await sql`select "composeStatus" from compose where "composeId" = ${composeId}`;
		if (row.composeStatus === "done") break;
		if (row.composeStatus === "error") throw new Error("deploy failed");
		await sleep(2_000);
	}
	const [stack] =
		await sql`select "appName" from compose where "composeId" = ${composeId}`;
	return { name, composeId, appName: stack.appName };
};

for (const engine of engines) {
	await check(
		`${engine.label} deploys, stays up and is reachable`,
		async () => {
			const stack = await deploy(engine);
			try {
				await sleep(settleMs(engine.id));
				const containers = docker(
					"ps",
					"-a",
					"--filter",
					`label=com.docker.compose.project=${stack.appName}`,
					"--format",
					"{{.Names}}",
				)
					.split("\n")
					.filter(Boolean);
				assert.ok(containers.length > 0, "no containers were created");
				for (const container of containers) {
					const { State: state, RestartCount: restarts } = JSON.parse(
						docker(
							"inspect",
							"-f",
							'{"State":{{json .State}},"RestartCount":{{.RestartCount}}}',
							container,
						),
					);
					const oneshot =
						docker(
							"inspect",
							"-f",
							'{{index .Config.Labels "com.abhash.oneshot"}}',
							container,
						) === "true";
					if (oneshot) {
						assert.equal(
							`${state.Status} ${state.ExitCode}`,
							"exited 0",
							`${container} did not finish: ${docker("logs", "--tail", "5", container)}`,
						);
						continue;
					}
					assert.equal(
						state.Status,
						"running",
						`${container} is ${state.Status} (exit ${state.ExitCode}): ${docker("logs", "--tail", "5", container)}`,
					);
					assert.ok(
						restarts === 0,
						`${container} restarted ${restarts} times: ${docker("logs", "--tail", "5", container)}`,
					);
					if (state.Health) {
						assert.notEqual(
							state.Health.Status,
							"unhealthy",
							`${container} is unhealthy`,
						);
					}
				}
				// The advertised address, reached from outside the stack. busybox
				// nslookup also tries the host's search domains and fails on
				// those, so ping, which resolves the way applications do.
				const service = docker(
					"inspect",
					"-f",
					'{{index .Config.Labels "com.docker.compose.service"}}',
					docker(
						"ps",
						"--filter",
						`label=com.docker.compose.project=${stack.appName}`,
						"--format",
						"{{.Names}}",
					).split("\n")[0],
				);
				docker(
					"run",
					"--rm",
					"--network",
					"dokploy-network",
					"busybox:1.37",
					"ping",
					"-c1",
					"-W3",
					`${stack.name}-${service}`,
				);
			} finally {
				await trpc(
					"compose.delete",
					{ composeId: stack.composeId, deleteVolumes: true },
					owner,
				);
			}
		},
	);
}

await trpc("project.remove", { projectId }, owner).catch(() => {});
await finish();
