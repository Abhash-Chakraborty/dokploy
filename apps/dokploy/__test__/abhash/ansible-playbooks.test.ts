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
		) as { "ansible.builtin.apt"?: { name?: string[] } } | undefined;
		expect(install?.["ansible.builtin.apt"]?.name).toContain("apt-utils");
	});

	it("never lets the repair step fail the run", () => {
		const repair = (baseline[0]?.tasks ?? []).find((task) =>
			task.name?.includes("half-configured"),
		) as { failed_when?: unknown } | undefined;
		expect(repair?.failed_when).toBe(false);
	});
});

describe("production failures of 2026-09-22", () => {
	const play = (file: string) =>
		(parse(PLATFORM_FILES[file] as string) as Play[])[0] as Play & {
			gather_facts?: boolean;
			gather_subset?: string[];
		};
	const tasks = (file: string) =>
		(play(file).tasks ?? []) as Array<Task & Record<string, unknown>>;

	it("baseline refreshes the package index before installing", () => {
		const install = tasks("baseline.yml").find(
			(t) => t.name === "Install the basics",
		);
		const apt = install?.["ansible.builtin.apt"] as
			| { update_cache?: boolean }
			| undefined;
		expect(apt?.update_cache).toBe(true);
	});

	it("patching repairs dpkg and the sshd runtime dir before upgrading", () => {
		const names = tasks("updates.yml").map((t) => t.name ?? "");
		const sshd = names.findIndex((n) => n.includes("sshd can be restarted"));
		const repair = names.findIndex((n) => n.includes("half-configured"));
		const upgrade = names.findIndex((n) => n.includes("upgrade"));
		expect(sshd).toBeGreaterThanOrEqual(0);
		expect(sshd).toBeLessThan(repair);
		expect(repair).toBeLessThan(upgrade);
	});

	it("cleanup gathers the facts its conditions use", () => {
		const cleanup = play("cleanup.yml");
		const usesServiceMgr = PLATFORM_FILES["cleanup.yml"]?.includes(
			"ansible_service_mgr",
		);
		if (usesServiceMgr) {
			expect(cleanup.gather_facts).toBe(true);
			expect(cleanup.gather_subset).toContain("min");
		}
	});

	it("cleanup only runs docker commands where Docker exists", () => {
		const tasks = (
			play("cleanup.yml") as { tasks: Array<Record<string, unknown>> }
		).tasks;
		for (const task of tasks) {
			const command = JSON.stringify(task["ansible.builtin.command"] ?? "");
			if (!command.includes("docker ") || command.includes("command -v"))
				continue;
			expect(JSON.stringify(task.when), String(task.name)).toContain(
				"dokploy_docker.rc == 0",
			);
		}
	});

	it("never reloads an inactive socket-activated sshd", () => {
		const handler = (
			(play("baseline.yml") as { handlers?: Array<Record<string, unknown>> })
				.handlers ?? []
		).find((h) => h.name === "reload sshd");
		expect(String(handler?.["ansible.builtin.shell"])).toContain("is-active");
	});
});
