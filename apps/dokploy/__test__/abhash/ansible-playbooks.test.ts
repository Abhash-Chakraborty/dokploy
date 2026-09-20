import { PLATFORM_FILES } from "@dokploy/server/services/abhash/ansible/playbooks";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Task = { name?: string; when?: unknown };
type Play = { name?: string; hosts?: string; tasks?: Task[] };

const plays = Object.entries(PLATFORM_FILES).map(
	([file, body]) => [file, parse(body) as Play[]] as const,
);

describe("ansible playbooks", () => {
	// They are template literals in a .ts file, so a broken edit is invisible
	// until a run fails on a real server.
	it.each(plays)("%s is valid YAML with one play", (_file, parsed) => {
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed).toHaveLength(1);
	});

	it.each(plays)("%s targets the dokploy inventory group", (_file, parsed) => {
		expect(parsed[0]?.hosts).toBe("dokploy");
	});

	it.each(plays)("%s gives every task a name", (_file, parsed) => {
		for (const task of parsed[0]?.tasks ?? []) {
			expect(task.name).toBeTruthy();
		}
	});
});

describe("baseline", () => {
	const baseline = parse(PLATFORM_FILES["baseline.yml"] as string) as Play[];
	const names = (baseline[0]?.tasks ?? []).map((task) => task.name);

	it("repairs a half-configured package state before installing anything", () => {
		const repair = names.findIndex((n) => n?.includes("half-configured"));
		const install = names.indexOf("Install the basics");
		expect(repair).toBeGreaterThanOrEqual(0);
		expect(install).toBeGreaterThanOrEqual(0);
		expect(repair).toBeLessThan(install);
	});

	it("installs apt-utils so debconf does not defer configuration", () => {
		const install = (baseline[0]?.tasks ?? []).find(
			(task) => task.name === "Install the basics",
		) as { "ansible.builtin.package"?: { name?: string[] } } | undefined;
		expect(install?.["ansible.builtin.package"]?.name).toContain("apt-utils");
	});

	it("never lets the repair step fail the run", () => {
		const repair = (baseline[0]?.tasks ?? []).find((task) =>
			task.name?.includes("half-configured"),
		) as { failed_when?: unknown } | undefined;
		expect(repair?.failed_when).toBe(false);
	});
});
