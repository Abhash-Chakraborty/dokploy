/**
 * Compose commands run under `env -i` so the host's environment cannot leak
 * into compose variable interpolation. That also wiped the Docker client's
 * own connection settings, so a Dokploy pointed at another daemon (the
 * sandbox's Docker-in-Docker, a remote DOCKER_HOST) sent compose to the local
 * socket instead. This carries just those settings through, and expands to
 * nothing when they are unset, which is the normal case in production.
 */
export const KEEP_DOCKER_ENV = [
	"DOCKER_HOST",
	"DOCKER_TLS_VERIFY",
	"DOCKER_CERT_PATH",
	"DOCKER_CONTEXT",
	"DOCKER_CONFIG",
]
	.map((name) => `\${${name}:+${name}="$${name}"}`)
	.join(" ");
