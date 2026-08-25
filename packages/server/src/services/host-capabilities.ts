import { existsSync } from "node:fs";
import { paths } from "../constants";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";

/**
 * A fix the panel can apply itself for a missing capability. Consumers switch
 * on this rather than matching `detail` strings, so the copy stays free to
 * change.
 */
export type HostCapabilityRemediation = "publish-traefik-dashboard-port";

/**
 * A single thing the panel needs from the host in order for some page to work.
 * `available: false` is a normal, expected state — a fresh box, a server that
 * hasn't finished provisioning, or an install where Traefik is managed
 * elsewhere — so every consumer should render a named empty state rather than
 * an error.
 */
export interface HostCapability {
	available: boolean;
	/** Short, user-facing explanation shown when `available` is false. */
	detail: string;
	/** Set only when `available` is false and the panel can fix it in place. */
	remediation?: HostCapabilityRemediation;
}

export interface HostCapabilities {
	docker: HostCapability;
	swarm: HostCapability;
	traefik: HostCapability;
	traefikDashboard: HostCapability;
	traefikConfig: HostCapability;
}

const ok = (detail = ""): HostCapability => ({ available: true, detail });
const missing = (
	detail: string,
	remediation?: HostCapabilityRemediation,
): HostCapability => ({
	available: false,
	detail,
	remediation,
});

const run = async (command: string, serverId?: string | null) =>
	serverId ? execAsyncRemote(serverId, command) : execAsync(command);

const probe = async (
	command: string,
	serverId: string | null | undefined,
	onMissing: string,
): Promise<{ capability: HostCapability; stdout: string }> => {
	try {
		const { stdout } = await run(command, serverId);
		return { capability: ok(), stdout: stdout.trim() };
	} catch {
		return { capability: missing(onMissing), stdout: "" };
	}
};

/**
 * Reports what this host can currently do, so pages that depend on Docker or
 * on a Dokploy-managed Traefik can say precisely what is missing instead of
 * rendering a broken panel.
 */
export const getHostCapabilities = async (
	serverId?: string | null,
): Promise<HostCapabilities> => {
	const docker = await probe(
		'docker version --format "{{.Server.Version}}"',
		serverId,
		"Docker isn't reachable from the panel. Check that the daemon is running and that the socket is mounted.",
	);

	if (!docker.capability.available) {
		const blocked = missing("Requires a reachable Docker daemon.");
		return {
			docker: docker.capability,
			swarm: blocked,
			traefik: blocked,
			traefikDashboard: blocked,
			traefikConfig: blocked,
		};
	}

	const [swarm, traefik] = await Promise.all([
		probe(
			'docker info --format "{{.Swarm.LocalNodeState}}"',
			serverId,
			"Swarm isn't active on this host.",
		),
		probe(
			'docker inspect --format "{{.State.Status}}" dokploy-traefik',
			serverId,
			"Traefik isn't managed by this Dokploy instance, so there's nothing to configure here.",
		),
	]);

	const swarmActive =
		swarm.capability.available && swarm.stdout === "active"
			? ok()
			: missing("Swarm isn't active on this host.");

	let traefikDashboard: HostCapability;
	if (!traefik.capability.available) {
		traefikDashboard = missing("Requires a Dokploy-managed Traefik.");
	} else {
		// `docker port` exits 0 with empty output when the container is running
		// but the port is not published, so the exit code alone is not enough.
		const port = await probe(
			"docker port dokploy-traefik 8080",
			serverId,
			"The Traefik dashboard port (8080) isn't published.",
		);
		traefikDashboard =
			port.capability.available && port.stdout.length > 0
				? ok()
				: missing(
						"The Traefik dashboard port (8080) isn't published.",
						"publish-traefik-dashboard-port",
					);
	}

	// Remote servers keep their config under /etc/dokploy, which we can only
	// stat over SSH; locally we can check the resolved path directly.
	const { MAIN_TRAEFIK_PATH } = paths(!!serverId);
	let traefikConfig: HostCapability;
	if (serverId) {
		const stat = await probe(
			`test -d ${MAIN_TRAEFIK_PATH} && echo ok`,
			serverId,
			`No Traefik configuration directory at ${MAIN_TRAEFIK_PATH}.`,
		);
		traefikConfig = stat.capability.available
			? ok()
			: missing(`No Traefik configuration directory at ${MAIN_TRAEFIK_PATH}.`);
	} else {
		traefikConfig = existsSync(MAIN_TRAEFIK_PATH)
			? ok()
			: missing(`No Traefik configuration directory at ${MAIN_TRAEFIK_PATH}.`);
	}

	return {
		docker: docker.capability,
		swarm: swarmActive,
		traefik: traefik.capability,
		traefikDashboard,
		traefikConfig,
	};
};
