import { createHash, randomBytes } from "node:crypto";
import { asRoot } from "../ssh/root";

/**
 * Host crontabs on a remote server, read and written over SSH.
 *
 * Everything already on the host is listed read-only. Jobs created from
 * Dokploy live in one file, /etc/cron.d/dokploy, each behind an id marker, so
 * Dokploy can add and remove its own entries without ever rewriting a file
 * someone maintains by hand.
 */

export const MANAGED_FILE = "/etc/cron.d/dokploy";
const MARKER = "# dokploy-id:";

export const READ_SCRIPT = [
	// Debian keeps user crontabs in crontabs/, RHEL directly in /var/spool/cron.
	'for f in /var/spool/cron/crontabs/* /var/spool/cron/*; do [ -f "$f" ] || continue; echo "@@SOURCE user $(basename "$f")"; cat "$f"; echo; done',
	'[ -f /etc/crontab ] && { echo "@@SOURCE file /etc/crontab"; cat /etc/crontab; echo; }',
	'for f in /etc/cron.d/*; do [ -f "$f" ] || continue; echo "@@SOURCE file $f"; cat "$f"; echo; done',
	'for p in hourly daily weekly monthly; do for f in /etc/cron.$p/*; do [ -f "$f" ] && [ -x "$f" ] && echo "@@PERIODIC $p $(basename "$f")"; done; done',
	"command -v systemctl >/dev/null 2>&1 && systemctl list-timers --all --no-legend --no-pager 2>/dev/null | sed 's/^/@@TIMER /'",
	"true",
].join("\n");

export const readCommand = () => asRoot(READ_SCRIPT, "DOKPLOY_CRON_READ");

export type HostCronSource = "user" | "file" | "periodic" | "timer";

export interface HostCronEntry {
	/** Stable across reads: derived from where the line lives and what it says. */
	id: string;
	source: HostCronSource;
	/** The user name for a user crontab, the path for a file, the period... */
	origin: string;
	schedule: string;
	user: string | null;
	command: string;
	managed: boolean;
	managedId?: string;
	name?: string;
}

const KEYWORD =
	/^@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)$/;
const FIELD = /^[\d*/,\-A-Za-z?LW#]+$/;
const ENV_LINE = /^[A-Za-z_][A-Za-z0-9_]*\s*=/;

const idOf = (...parts: string[]) =>
	createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 12);

/** Splits a crontab line into schedule, optional user and command. */
const splitLine = (
	line: string,
	hasUserField: boolean,
): { schedule: string; user: string | null; command: string } | null => {
	const tokens = line.trim().split(/\s+/);
	let scheduleTokens: string[];
	if (KEYWORD.test(tokens[0] ?? "")) {
		scheduleTokens = tokens.slice(0, 1);
	} else {
		scheduleTokens = tokens.slice(0, 5);
		if (
			scheduleTokens.length < 5 ||
			!scheduleTokens.every((t) => FIELD.test(t))
		)
			return null;
	}
	let rest = tokens.slice(scheduleTokens.length);
	let user: string | null = null;
	if (hasUserField) {
		user = rest[0] ?? null;
		rest = rest.slice(1);
	}
	if (rest.length === 0) return null;
	// Keep the command's own spacing: cut the schedule (and user) off the
	// original line instead of re-joining tokens.
	let command = line.trim();
	for (const token of [...scheduleTokens, ...(user ? [user] : [])]) {
		command = command.slice(command.indexOf(token) + token.length).trimStart();
	}
	return { schedule: scheduleTokens.join(" "), user, command };
};

export const parseHostCron = (stdout: string): HostCronEntry[] => {
	const entries: HostCronEntry[] = [];
	let source: { kind: "user" | "file"; origin: string } | null = null;
	let pending: { id: string; name: string } | null = null;

	for (const raw of stdout.split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (line.startsWith("@@SOURCE ")) {
			const [, kind, ...rest] = line.split(" ");
			source =
				kind === "user" || kind === "file"
					? { kind, origin: rest.join(" ") }
					: null;
			pending = null;
			continue;
		}
		if (line.startsWith("@@PERIODIC ")) {
			const [, period, name] = line.split(" ");
			if (!period || !name) continue;
			entries.push({
				id: idOf("periodic", period, name),
				source: "periodic",
				origin: `/etc/cron.${period}`,
				schedule: `@${period}`,
				user: "root",
				command: `/etc/cron.${period}/${name}`,
				managed: false,
			});
			continue;
		}
		if (line.startsWith("@@TIMER ")) {
			const tokens = line.slice("@@TIMER ".length).trim().split(/\s+/);
			const unit = tokens.at(-2);
			const activates = tokens.at(-1);
			if (!unit?.endsWith(".timer")) continue;
			// Everything before UNIT is NEXT, LEFT, LAST, PASSED; "n/a" when unset.
			const next = tokens.slice(0, 4).join(" ");
			entries.push({
				id: idOf("timer", unit),
				source: "timer",
				origin: unit,
				schedule: next.startsWith("n/a") ? "inactive" : `next ${next}`,
				user: null,
				command: activates ?? unit,
				managed: false,
			});
			continue;
		}
		if (!source) continue;
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (trimmed.startsWith(MARKER)) {
			const [id, ...name] = trimmed.slice(MARKER.length).trim().split(" ");
			pending = id ? { id, name: name.join(" ") } : null;
			continue;
		}
		if (trimmed.startsWith("#") || ENV_LINE.test(trimmed)) continue;
		const parsed = splitLine(trimmed, source.kind === "file");
		if (!parsed) continue;
		const managed = source.kind === "file" && source.origin === MANAGED_FILE;
		entries.push({
			id: idOf(source.kind, source.origin, trimmed),
			source: source.kind,
			origin: source.origin,
			schedule: parsed.schedule,
			user: source.kind === "user" ? source.origin : parsed.user,
			command: parsed.command,
			managed: managed && !!pending,
			...(managed && pending
				? { managedId: pending.id, name: pending.name || undefined }
				: {}),
		});
		pending = null;
	}
	return entries;
};

export interface NewHostCron {
	name: string;
	schedule: string;
	user: string;
	command: string;
}

export const validateHostCron = (entry: NewHostCron): string | null => {
	const schedule = entry.schedule.trim();
	if (!KEYWORD.test(schedule)) {
		const fields = schedule.split(/\s+/);
		if (fields.length !== 5 || !fields.every((field) => FIELD.test(field)))
			return "The schedule must be five cron fields or a keyword like @daily";
	}
	if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(entry.user))
		return "The user must be a plain Linux user name";
	if (!entry.command.trim()) return "The command is empty";
	if (/[\r\n]/.test(entry.command) || /[\r\n]/.test(entry.name))
		return "Commands and names must be a single line";
	// cron treats an unescaped % as a newline; anything else is the shell's.
	if (/(^|[^\\])%/.test(entry.command))
		return "Escape % as \\% in cron commands";
	if (entry.command.length > 1_000) return "The command is too long";
	if (entry.name.length > 80) return "The name is too long";
	return null;
};

export const newManagedId = () => randomBytes(6).toString("hex");

export const renderManagedFile = (
	entries: Array<NewHostCron & { managedId: string }>,
) =>
	[
		"# Managed by Dokploy. Entries are added and removed from the dashboard;",
		"# edits made here by hand are overwritten on the next change.",
		"SHELL=/bin/sh",
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"",
		...entries.flatMap((entry) => [
			`${MARKER} ${entry.managedId} ${entry.name}`.trimEnd(),
			`${entry.schedule.trim()} ${entry.user} ${entry.command.trim()}`,
		]),
		"",
	].join("\n");

/**
 * Written through base64 so no quoting in a command can escape into the
 * shell, and moved into place so cron never reads a half-written file.
 */
export const writeCommand = (content: string) => {
	const encoded = Buffer.from(content, "utf8").toString("base64");
	return asRoot(
		[
			`[ -d /etc/cron.d ] || { echo "cron is not installed on this server (no /etc/cron.d)" >&2; exit 1; }`,
			`printf '%s' '${encoded}' | base64 -d > ${MANAGED_FILE}.tmp`,
			`chmod 0644 ${MANAGED_FILE}.tmp`,
			`mv ${MANAGED_FILE}.tmp ${MANAGED_FILE}`,
		].join(" && "),
		"DOKPLOY_CRON_WRITE",
	);
};
