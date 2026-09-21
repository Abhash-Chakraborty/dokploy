export const NEEDS_ROOT =
	"Dokploy needs root or passwordless sudo on this server";

/**
 * Wraps a script that needs root so it runs over SSH as whatever user the
 * server is registered with. Upstream supports a non-root user with
 * passwordless sudo, and most cloud images hand you exactly that, so running
 * the script straight through `sh -s` fails on the first privileged command.
 *
 * Root runs it directly; anyone else runs it under `sudo -n`, which fails
 * rather than prompting; and with neither, it stops before doing anything,
 * with a message that says what to fix. Only the chosen `sh` reads the
 * heredoc: the probes read from /dev/null so they cannot swallow the script.
 */
export const asRoot = (script: string, marker = "DOKPLOY_ROOT") => {
	if (!/^[A-Z][A-Z0-9_]*$/.test(marker)) {
		throw new Error(`Invalid heredoc marker "${marker}"`);
	}
	if (script.split("\n").some((line) => line === marker)) {
		throw new Error(`The script contains its own heredoc marker "${marker}"`);
	}
	return [
		`if [ "$(id -u </dev/null)" -eq 0 ]; then sh -s; elif sudo -n true </dev/null 2>/dev/null; then sudo -n sh -s; else echo "${NEEDS_ROOT}" >&2; exit 1; fi <<'${marker}'`,
		script,
		marker,
	].join("\n");
};
