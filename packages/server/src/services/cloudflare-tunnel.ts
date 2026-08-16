import { quote } from "shell-quote";

/** One connector per host; a second would just duplicate the tunnel. */
export const CLOUDFLARE_TUNNEL_CONTAINER = "dokploy-cloudflared";

/** Pinned so a working tunnel keeps working across host reboots. */
export const CLOUDFLARE_TUNNEL_IMAGE = "cloudflare/cloudflared:2026.8.2";

/**
 * The connector joins Cloudflare's edge over an outbound connection, so the
 * host needs no public IP and no inbound ports — which is the whole point.
 *
 * `--no-autoupdate` because the image tag is pinned; letting the binary update
 * itself underneath a pinned image is how you get a version you never chose.
 */
export const buildDeployCloudflareTunnelCommand = (token: string) =>
	[
		`docker rm -f ${CLOUDFLARE_TUNNEL_CONTAINER} 2>/dev/null || true`,
		[
			"docker run -d",
			`--name ${CLOUDFLARE_TUNNEL_CONTAINER}`,
			"--restart unless-stopped",
			"--network host",
			"--log-driver json-file --log-opt max-size=10m --log-opt max-file=3",
			// Passed via env so the token never lands in `docker inspect`'s Cmd
			// or in the host's shell history.
			`-e TUNNEL_TOKEN=${quote([token])}`,
			CLOUDFLARE_TUNNEL_IMAGE,
			"tunnel --no-autoupdate run",
		].join(" "),
	].join("\n");

export const buildRemoveCloudflareTunnelCommand = () =>
	`docker rm -f ${CLOUDFLARE_TUNNEL_CONTAINER} 2>/dev/null || true`;

/**
 * Reports whether the connector is running and what it last said. Cloudflare
 * logs "Registered tunnel connection" once the edge accepts it, which is the
 * only signal that the token is actually valid.
 */
export const buildCloudflareTunnelStatusCommand = () =>
	[
		`state=$(docker inspect --format "{{.State.Status}}" ${CLOUDFLARE_TUNNEL_CONTAINER} 2>/dev/null | tr -d "\r\n")`,
		'[ -z "$state" ] && state=missing',
		`logs=$(docker logs --tail 40 ${CLOUDFLARE_TUNNEL_CONTAINER} 2>&1 || echo "")`,
		'connections=$(echo "$logs" | grep -c "Registered tunnel connection" || true)',
		'errors=$(echo "$logs" | grep -iE "error|unauthorized|failed to" | tail -3 || true)',
		'printf \'{"state":"%s","connections":"%s","errors":"%s"}\' "$state" "$connections" "$(echo "$errors" | tr \'\\n\' \' \' | sed \'s/"/\\\\"/g\')"',
	].join("\n");

export interface CloudflareTunnelStatus {
	running: boolean;
	/** Edge connections registered; 0 with a running container means a bad token. */
	connections: number;
	detail: string;
}

export const parseCloudflareTunnelStatus = (
	stdout: string,
): CloudflareTunnelStatus => {
	try {
		const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as {
			state?: string;
			connections?: string;
			errors?: string;
		};
		const running = parsed.state === "running";
		const connections = Number.parseInt(parsed.connections ?? "0", 10) || 0;

		if (!running) {
			return {
				running: false,
				connections: 0,
				detail:
					parsed.state === "missing"
						? "The connector isn't running on this host."
						: `Connector is ${parsed.state}. ${parsed.errors ?? ""}`.trim(),
			};
		}
		if (connections === 0) {
			return {
				running: true,
				connections: 0,
				detail:
					parsed.errors?.trim() ||
					"Running, but no edge connection registered yet — usually an invalid or revoked token.",
			};
		}
		return {
			running: true,
			connections,
			detail: `${connections} edge connection${connections === 1 ? "" : "s"} registered.`,
		};
	} catch {
		return {
			running: false,
			connections: 0,
			detail: "Could not read the connector's status.",
		};
	}
};
