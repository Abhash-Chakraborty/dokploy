import { execFileSync } from "node:child_process";
import {
	MANAGED_FILE,
	parseHostCron,
	renderManagedFile,
	validateHostCron,
	writeCommand,
} from "@dokploy/server/services/abhash/cron/host-cron";
import { describe, expect, it } from "vitest";

const SAMPLE = [
	"@@SOURCE user root",
	"# m h dom mon dow command",
	"MAILTO=ops@example.com",
	"*/5 * * * * /usr/local/bin/backup.sh  --fast   >/dev/null 2>&1",
	"@reboot /opt/start.sh",
	"",
	"@@SOURCE file /etc/crontab",
	"SHELL=/bin/sh",
	"17 *	* * *	root	cd / && run-parts --report /etc/cron.hourly",
	"",
	"@@SOURCE file /etc/cron.d/certbot",
	"0 */12 * * * root test -x /usr/bin/certbot && certbot -q renew",
	"",
	`@@SOURCE file ${MANAGED_FILE}`,
	"# Managed by Dokploy.",
	"SHELL=/bin/sh",
	"# dokploy-id: a1b2c3 Nightly prune",
	"0 3 * * * root docker system prune -f",
	"30 4 * * * root echo written by hand",
	"@@PERIODIC daily logrotate",
	"@@TIMER Mon 2026-09-22 00:00:00 UTC 12h left Sun 2026-09-21 00:00:00 UTC 11h ago logrotate.timer logrotate.service",
	"@@TIMER n/a n/a n/a n/a snapd.snap-repair.timer snapd.snap-repair.service",
].join("\n");

describe("parseHostCron", () => {
	const entries = parseHostCron(SAMPLE);
	const by = (command: string) =>
		entries.find((entry) => entry.command.startsWith(command));

	it("reads user crontabs without a user column, keeping command spacing", () => {
		expect(by("/usr/local/bin/backup.sh")).toMatchObject({
			source: "user",
			origin: "root",
			user: "root",
			schedule: "*/5 * * * *",
			command: "/usr/local/bin/backup.sh  --fast   >/dev/null 2>&1",
			managed: false,
		});
		expect(by("/opt/start.sh")?.schedule).toBe("@reboot");
	});

	it("reads system files with their user column, tabs included", () => {
		expect(by("cd / && run-parts")).toMatchObject({
			source: "file",
			origin: "/etc/crontab",
			user: "root",
			schedule: "17 * * * *",
		});
		expect(by("test -x /usr/bin/certbot")?.origin).toBe("/etc/cron.d/certbot");
	});

	it("skips comments and environment lines", () => {
		expect(entries.some((e) => e.command.includes("MAILTO"))).toBe(false);
		expect(entries.some((e) => e.command.includes("SHELL"))).toBe(false);
	});

	it("marks only Dokploy's marked lines as managed", () => {
		expect(by("docker system prune")).toMatchObject({
			managed: true,
			managedId: "a1b2c3",
			name: "Nightly prune",
		});
		expect(by("echo written by hand")?.managed).toBe(false);
	});

	it("lists periodic scripts and systemd timers", () => {
		expect(by("/etc/cron.daily/logrotate")).toMatchObject({
			source: "periodic",
			schedule: "@daily",
		});
		const timer = entries.find((e) => e.origin === "logrotate.timer");
		expect(timer?.schedule).toMatch(/^next Mon 2026-09-22/);
		expect(timer?.command).toBe("logrotate.service");
		expect(
			entries.find((e) => e.origin === "snapd.snap-repair.timer")?.schedule,
		).toBe("inactive");
	});

	it("gives each line a stable id", () => {
		const again = parseHostCron(SAMPLE);
		expect(again.map((e) => e.id)).toEqual(entries.map((e) => e.id));
		expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
	});
});

describe("validateHostCron", () => {
	const ok = { name: "x", schedule: "0 3 * * *", user: "root", command: "ls" };

	it("accepts plain schedules and keywords", () => {
		expect(validateHostCron(ok)).toBeNull();
		expect(validateHostCron({ ...ok, schedule: "@daily" })).toBeNull();
		expect(
			validateHostCron({ ...ok, schedule: "*/15 1-5 * JAN mon" }),
		).toBeNull();
	});

	it("rejects anything that could break out of its line", () => {
		expect(validateHostCron({ ...ok, schedule: "0 3 * *" })).toMatch(/five/);
		expect(validateHostCron({ ...ok, schedule: "0 3 * * * rm" })).toMatch(
			/five/,
		);
		expect(validateHostCron({ ...ok, user: "root; rm -rf /" })).toMatch(/user/);
		expect(
			validateHostCron({ ...ok, command: "ls\n* * * * * root rm" }),
		).toMatch(/single line/);
		expect(validateHostCron({ ...ok, name: "a\nb" })).toMatch(/single line/);
		expect(validateHostCron({ ...ok, command: "date +%F" })).toMatch(/%/);
		expect(validateHostCron({ ...ok, command: "date +\\%F" })).toBeNull();
	});
});

describe("renderManagedFile and writeCommand", () => {
	it("round-trips through the parser", () => {
		const content = renderManagedFile([
			{
				managedId: "abc123",
				name: "Prune",
				schedule: "0 3 * * *",
				user: "root",
				command: "docker system prune -f",
			},
		]);
		const parsed = parseHostCron(`@@SOURCE file ${MANAGED_FILE}\n${content}`);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toMatchObject({
			managed: true,
			managedId: "abc123",
			name: "Prune",
			command: "docker system prune -f",
		});
	});

	it("carries hostile content as inert base64", () => {
		const content = renderManagedFile([
			{
				managedId: "x",
				name: "'; touch /tmp/pwned; '",
				schedule: "@daily",
				user: "root",
				command: "echo '$(id)' `id` \"$HOME\"",
			},
		]);
		const command = writeCommand(content);
		expect(command).not.toContain("touch /tmp/pwned");
		expect(command).not.toContain("$(id)");
		// The script decodes back to exactly what was rendered.
		const encoded = command.match(/printf '%s' '([A-Za-z0-9+/=]+)'/)?.[1];
		expect(Buffer.from(encoded as string, "base64").toString()).toBe(content);
		expect(() =>
			execFileSync("sh", ["-n", "-c", command], { stdio: "pipe" }),
		).not.toThrow();
	});
});
