import { join } from "node:path";
import { quote } from "shell-quote";
import { paths } from "../constants";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";
import { findComposeById } from "./compose";

/**
 * Compose service names follow the same grammar Docker uses for them. Anything
 * outside it isn't a service on this stack, so it's rejected rather than
 * escaped — the value goes into a shell command either way.
 */
const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export const isValidComposeServiceName = (name: string) =>
	name.length > 0 && name.length <= 128 && SERVICE_NAME.test(name);

const assertServiceName = (serviceName: string) => {
	if (!isValidComposeServiceName(serviceName)) {
		throw new Error(`Not a valid compose service name: ${serviceName}`);
	}
};

const composeContext = async (composeId: string) => {
	const compose = await findComposeById(composeId);
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	const projectPath = join(COMPOSE_PATH, compose.appName, "code");
	const composeFile =
		compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath;
	return { compose, projectPath, composeFile };
};

const run = async (
	serverId: string | null,
	projectPath: string,
	command: string,
) =>
	serverId
		? execAsyncRemote(serverId, `cd ${projectPath} && ${command}`)
		: execAsync(command, { cwd: projectPath });

/**
 * Restarts one service without touching the rest of the stack.
 *
 * Swarm has no per-service restart, so a forced update is the equivalent: it
 * reschedules the service's tasks while leaving its definition alone.
 */
export const restartComposeService = async (
	composeId: string,
	serviceName: string,
) => {
	assertServiceName(serviceName);
	const { compose, projectPath, composeFile } = await composeContext(composeId);

	if (compose.composeType === "stack") {
		const command = `docker service update --force ${quote([`${compose.appName}_${serviceName}`])}`;
		await run(compose.serverId, projectPath, command);
		return;
	}

	const command = `env -i PATH="$PATH" docker compose -p ${quote([compose.appName])} -f ${quote([composeFile])} restart ${quote([serviceName])}`;
	await run(compose.serverId, projectPath, command);
};

/**
 * Scales one service. `--no-recreate` keeps the containers that are already
 * running exactly as they are, so scaling up doesn't quietly restart
 * everything that was already serving.
 */
export const scaleComposeService = async (
	composeId: string,
	serviceName: string,
	replicas: number,
) => {
	assertServiceName(serviceName);
	if (!Number.isInteger(replicas) || replicas < 0 || replicas > 100) {
		throw new Error("Replicas must be a whole number between 0 and 100");
	}
	const { compose, projectPath, composeFile } = await composeContext(composeId);

	if (compose.composeType === "stack") {
		const command = `docker service scale ${quote([`${compose.appName}_${serviceName}=${replicas}`])}`;
		await run(compose.serverId, projectPath, command);
		return;
	}

	const command = `env -i PATH="$PATH" docker compose -p ${quote([compose.appName])} -f ${quote([composeFile])} up -d --no-recreate --no-deps --scale ${quote([`${serviceName}=${replicas}`])} ${quote([serviceName])}`;
	await run(compose.serverId, projectPath, command);
};
