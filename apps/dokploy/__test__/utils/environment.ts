import { execFileSync, execSync } from "node:child_process";

/**
 * Probes for the tools some suites shell out to.
 *
 * Several tests exercise generated shell or drive Docker directly. Those are
 * worth running wherever the tools exist — including Windows, where Git for
 * Windows ships bash but `/bin/bash` isn't the path to it — and worth skipping
 * with a reason where they don't, rather than failing on the platform.
 */

const which = (name: string): string | null => {
	try {
		const finder = process.platform === "win32" ? "where" : "which";
		const [first] = execFileSync(finder, [name], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).split("\n");
		return first?.trim() || null;
	} catch {
		return null;
	}
};

/** Absolute path to a bash the current platform can spawn, or null. */
export const findBash = (): string | null =>
	process.platform === "win32" ? which("bash") : "/bin/bash";

/** True when a Docker daemon is actually reachable, not merely installed. */
export const hasDocker = (): boolean => {
	try {
		execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
};

/** True when `docker compose` (v2, as a subcommand) is available. */
export const hasDockerCompose = (): boolean => {
	if (!hasDocker()) return false;
	try {
		execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

/**
 * True when the *default* shell understands POSIX.
 *
 * Having bash on PATH isn't enough for code that shells out through
 * `child_process.exec`: that uses the platform default, which on Windows is
 * cmd.exe, where `mkdir -p` and friends don't exist. Probed rather than
 * inferred from the platform so a POSIX-default Windows setup still counts.
 */
export const hasPosixDefaultShell = (): boolean => {
	try {
		// Probes shell *syntax*, not a binary on PATH: Git for Windows puts
		// printf.exe and friends where cmd.exe can find them, so running a
		// coreutil proves nothing. cmd.exe echoes `$VAR` literally.
		const out = execSync("echo $DOKPLOY_SHELL_PROBE", {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			env: { ...process.env, DOKPLOY_SHELL_PROBE: "posix" },
		});
		return out.trim() === "posix";
	} catch {
		return false;
	}
};

/**
 * Everything the "real execution" deployment suite needs. It runs the actual
 * builders, which shell out through the default shell, so that has to be POSIX
 * as well as git and Docker being present.
 */
export const hasRealDeployToolchain = (): boolean =>
	hasPosixDefaultShell() && which("git") !== null && hasDocker();
