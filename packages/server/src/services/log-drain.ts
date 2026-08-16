import type { LogDrainConfig } from "../db/schema/log-drain";

/**
 * Container name for the shipper. One per host: Vector reads the Docker socket
 * and picks up every container, so a second instance would only duplicate
 * every line.
 */
export const LOG_DRAIN_CONTAINER = "dokploy-log-drain";

/** Pinned so a drain that works today keeps working after a host reboot. */
export const LOG_DRAIN_IMAGE = "timberio/vector:0.44.0-alpine";

const toToml = (value: string) => JSON.stringify(value);

const tomlTable = (entries: Record<string, string>) =>
	Object.entries(entries)
		.map(([key, entry]) => `${toToml(key)} = ${toToml(entry)}`)
		.join("\n");

/**
 * Builds a Vector config that tails every container on the host and forwards
 * to the configured sink.
 *
 * Vector is the shipper rather than something hand-rolled because container
 * log tailing has to survive restarts, rotation and partial lines, and none of
 * that is worth reimplementing.
 */
export const buildVectorConfig = (
	config: LogDrainConfig,
	{ hostname }: { hostname: string },
): string => {
	const extraVrl =
		config.drainType === "datadog" && config.tags
			? `
.ddtags = ${toToml(config.tags)}`
			: "";

	const source = `
data_dir = "/vector-data"

[api]
enabled = false

[sources.docker]
type = "docker_logs"
# The shipper's own output would otherwise feed back into itself.
exclude_containers = ["${LOG_DRAIN_CONTAINER}"]

[transforms.enrich]
type = "remap"
inputs = ["docker"]
source = '''
.host = ${toToml(hostname)}
.service = .label."com.docker.swarm.service.name" || .container_name
.project = .label."com.docker.compose.project" || ""${extraVrl}
'''
`.trim();

	if (config.drainType === "loki") {
		const labels = {
			host: "{{ host }}",
			service: "{{ service }}",
			container: "{{ container_name }}",
			...config.labels,
		};
		const auth =
			config.username && config.password
				? `
[sinks.out.auth]
strategy = "basic"
user = ${toToml(config.username)}
password = ${toToml(config.password)}
`
				: "";

		return `${source}

[sinks.out]
type = "loki"
inputs = ["enrich"]
endpoint = ${toToml(config.endpoint)}
encoding.codec = "json"
# Vector refuses out-of-order pushes to the same stream by default; Docker
# timestamps across containers are not globally ordered.
out_of_order_action = "accept"

[sinks.out.labels]
${tomlTable(labels)}
${auth}`.trimEnd();
	}

	if (config.drainType === "datadog") {
		return `${source}

[sinks.out]
type = "datadog_logs"
inputs = ["enrich"]
default_api_key = ${toToml(config.apiKey)}
site = ${toToml(config.site)}
endpoint = ${toToml(config.endpoint)}
compression = "gzip"`.trimEnd();
	}

	const headers = Object.keys(config.headers).length
		? `
[sinks.out.request.headers]
${tomlTable(config.headers)}
`
		: "";

	return `${source}

[sinks.out]
type = "http"
inputs = ["enrich"]
uri = ${toToml(config.endpoint)}
encoding.codec = ${toToml(config.encoding === "text" ? "text" : "json")}
${headers}`.trimEnd();
};

/**
 * Redacts anything that would leak a credential into a UI, a log line or an
 * audit entry. Callers that persist or display a config should go through this.
 */
export const redactLogDrainConfig = (
	config: LogDrainConfig,
): LogDrainConfig => {
	if (config.drainType === "loki") {
		return { ...config, password: config.password ? "********" : undefined };
	}
	if (config.drainType === "datadog") {
		return { ...config, apiKey: "********" };
	}
	return {
		...config,
		headers: Object.fromEntries(
			Object.keys(config.headers).map((key) => [key, "********"]),
		),
	};
};

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

const CONFIG_DIR = "/etc/dokploy/log-drain";
const CONFIG_PATH = `${CONFIG_DIR}/vector.toml`;
const DATA_DIR = "/etc/dokploy/log-drain/data";

/**
 * Writes the config and (re)starts the shipper. Idempotent: an existing
 * container is removed first, so calling this after an edit rolls the drain
 * onto the new config.
 */
export const buildDeployLogDrainCommand = (vectorConfig: string) => {
	const encoded = Buffer.from(vectorConfig, "utf8").toString("base64");
	return [
		`mkdir -p ${CONFIG_DIR} ${DATA_DIR}`,
		// If the shipper ever started before this file existed, Docker created a
		// *directory* at the bind-mount source and every later write fails with
		// "Is a directory". We own this path and rewrite it wholesale, so clear
		// whatever is there first.
		`rm -rf ${CONFIG_PATH}`,
		`echo "${encoded}" | base64 -d > ${CONFIG_PATH}`,
		`docker rm -f ${LOG_DRAIN_CONTAINER} 2>/dev/null || true`,
		[
			"docker run -d",
			`--name ${LOG_DRAIN_CONTAINER}`,
			"--restart unless-stopped",
			"--log-driver json-file --log-opt max-size=10m --log-opt max-file=3",
			"-v /var/run/docker.sock:/var/run/docker.sock:ro",
			`-v ${CONFIG_PATH}:/etc/vector/vector.toml:ro`,
			`-v ${DATA_DIR}:/vector-data`,
			LOG_DRAIN_IMAGE,
			"--config /etc/vector/vector.toml",
		].join(" "),
	].join("\n");
};

export const buildRemoveLogDrainCommand = () =>
	`docker rm -f ${LOG_DRAIN_CONTAINER} 2>/dev/null || true`;

/**
 * Validates a config without shipping anything: Vector parses the file and
 * exits non-zero with the reason if it's wrong.
 */
export const buildValidateLogDrainCommand = (vectorConfig: string) => {
	const encoded = Buffer.from(vectorConfig, "utf8").toString("base64");
	return [
		`mkdir -p ${CONFIG_DIR}`,
		`rm -rf ${CONFIG_PATH}.check`,
		`echo "${encoded}" | base64 -d > ${CONFIG_PATH}.check`,
		[
			"docker run --rm",
			`-v ${CONFIG_PATH}.check:/etc/vector/vector.toml:ro`,
			LOG_DRAIN_IMAGE,
			"validate --no-environment --config-toml /etc/vector/vector.toml",
		].join(" "),
		`rm -f ${CONFIG_PATH}.check`,
	].join("\n");
};
