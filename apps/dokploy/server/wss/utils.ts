import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { IS_CLOUD, paths } from "@dokploy/server";

const execFileAsync = promisify(execFile);

export const TERMINAL_RESIZE_MESSAGE_PREFIX = "\u0000dokploy-resize:";

export interface TerminalDimensions {
	cols: number;
	rows: number;
}

const clampTerminalDimension = (value: unknown, min: number, max: number) => {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.min(max, Math.max(min, Math.floor(value)));
};

/** Parse the private control frame used to resize an SSH PTY. */
export const parseTerminalResizeMessage = (
	message: string,
): TerminalDimensions | null => {
	if (!message.startsWith(TERMINAL_RESIZE_MESSAGE_PREFIX)) return null;
	try {
		const value = JSON.parse(
			message.slice(TERMINAL_RESIZE_MESSAGE_PREFIX.length),
		) as { cols?: unknown; rows?: unknown };
		const cols = clampTerminalDimension(value.cols, 20, 500);
		const rows = clampTerminalDimension(value.rows, 5, 300);
		return cols && rows ? { cols, rows } : null;
	} catch {
		return null;
	}
};

/**
 * Validates that the container ID matches Docker's expected format.
 * Docker container IDs are 64-character hex strings (or 12-char short form).
 * Also allows container names: alphanumeric, underscores, hyphens, and dots.
 */
export const isValidContainerId = (id: string): boolean => {
	// Match full ID (64 hex chars), short ID (12 hex chars), or container name
	const hexPattern = /^[a-f0-9]{12,64}$/i;
	const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
	return hexPattern.test(id) || (namePattern.test(id) && id.length <= 128);
};

/**
 * Validates the `tail` parameter for docker logs (number of lines, max 10000).
 * Prevents command injection by allowing only digits.
 */
export const isValidTail = (tail: string): boolean => {
	return (
		/^\d+$/.test(tail) &&
		Number.parseInt(tail, 10) <= 10000 &&
		Number.parseInt(tail, 10) >= 0
	);
};

/**
 * Validates the `since` parameter for docker logs: "all" or duration like 5s, 10m, 1h, 2d.
 * Prevents command injection by allowing only a strict format.
 */
export const isValidSince = (since: string): boolean => {
	return since === "all" || /^\d+[smhd]$/.test(since);
};

/**
 * Validates the `search` parameter for log filtering.
 * Search is concatenated into shell commands (SSH path: double quotes; local path: single quotes).
 * Only allow alphanumeric, space, dot, underscore, hyphen to prevent $, `, ', " from enabling command injection.
 * Max length 500.
 */
export const isValidSearch = (search: string): boolean => {
	// Space only (not \s) to reject \n, \r, \t and other control chars
	return /^[a-zA-Z0-9 ._-]{0,500}$/.test(search);
};

/**
 * Validates that the shell is one of the allowed shells.
 */
export const isValidShell = (shell: string): boolean => {
	const allowedShells = [
		"sh",
		"bash",
		"zsh",
		"ash",
		"/bin/sh",
		"/bin/bash",
		"/bin/zsh",
		"/bin/ash",
	];
	return allowedShells.includes(shell);
};

export const getShell = () => {
	if (IS_CLOUD) {
		return "NO_AVAILABLE";
	}
	switch (os.platform()) {
		case "win32":
			return "powershell.exe";
		case "darwin":
			return "zsh";
		default:
			return "bash";
	}
};

/** Returns private SSH key for dokploy local server terminal. Uses already created SSH key or generates a new SSH key.
 */
export const setupLocalServerSSHKey = async () => {
	const { SSH_PATH } = paths(true);
	const sshKeyPath = path.join(SSH_PATH, "auto_generated-dokploy-local");
	const publicKeyPath = `${sshKeyPath}.pub`;

	fs.mkdirSync(SSH_PATH, { recursive: true, mode: 0o700 });
	fs.chmodSync(SSH_PATH, 0o700);

	if (!fs.existsSync(sshKeyPath)) {
		await execFileAsync("ssh-keygen", [
			"-t",
			"ed25519",
			"-f",
			sshKeyPath,
			"-N",
			"",
			"-C",
			"dokploy-local-access",
		]);
	} else if (!fs.existsSync(publicKeyPath)) {
		const { stdout } = await execFileAsync("ssh-keygen", [
			"-y",
			"-f",
			sshKeyPath,
		]);
		fs.writeFileSync(publicKeyPath, `${stdout.trim()} dokploy-local-access\n`, {
			mode: 0o644,
		});
	}

	fs.chmodSync(sshKeyPath, 0o600);

	const privateKey = fs.readFileSync(sshKeyPath, "utf8");

	return privateKey;
};
