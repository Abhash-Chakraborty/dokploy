import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { summarizeApplyFailures } from "@dokploy/server/services/abhash/firewall/apply";
import { asRoot, NEEDS_ROOT } from "@dokploy/server/services/abhash/ssh/root";
import { afterEach, describe, expect, it } from "vitest";

// Real sudo would make the result depend on whoever runs the suite, so each
// case gets fake `id` and `sudo` binaries on PATH instead.
const dirs: string[] = [];
const fakeHost = (options: { uid: number; sudo: "ok" | "denied" }) => {
	const dir = mkdtempSync(path.join(tmpdir(), "asroot-"));
	dirs.push(dir);
	const write = (name: string, body: string) => {
		const file = path.join(dir, name);
		writeFileSync(file, `#!/bin/sh\n${body}\n`);
		chmodSync(file, 0o755);
	};
	write("id", `echo ${options.uid}`);
	write(
		"sudo",
		options.sudo === "ok"
			? // `sudo -n true` succeeds; `sudo -n sh -s` runs the script elevated.
				'shift; if [ "$1" = true ]; then exit 0; fi; ELEVATED=1 exec "$@"'
			: "exit 1",
	);
	return { ...process.env, PATH: `${dir}:${process.env.PATH}` };
};

const run = (command: string, env: NodeJS.ProcessEnv) =>
	spawnSync("sh", ["-c", command], { env, encoding: "utf8" });

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const script = 'echo "elevated=${ELEVATED:-0}"\necho second line';

describe("asRoot", () => {
	it("runs the script directly when already root", () => {
		const out = run(asRoot(script), fakeHost({ uid: 0, sudo: "denied" }));
		expect(out.status).toBe(0);
		expect(out.stdout).toBe("elevated=0\nsecond line\n");
	});

	it("runs the script under sudo for a non-root user that has it", () => {
		const out = run(asRoot(script), fakeHost({ uid: 1000, sudo: "ok" }));
		expect(out.status).toBe(0);
		expect(out.stdout).toBe("elevated=1\nsecond line\n");
	});

	it("stops before running anything when there is neither", () => {
		const out = run(asRoot(script), fakeHost({ uid: 1000, sudo: "denied" }));
		expect(out.status).toBe(1);
		expect(out.stdout).toBe("");
		expect(out.stderr).toContain(NEEDS_ROOT);
	});

	it("keeps the whole script, including shell syntax, unexpanded", () => {
		const tricky = "X=$(echo inner)\necho \"$X ${HOME:+set}\" '$literal'";
		const out = run(asRoot(tricky), fakeHost({ uid: 0, sudo: "denied" }));
		expect(out.stdout).toBe("inner set $literal\n");
	});

	it("rejects a marker that could break the heredoc", () => {
		expect(() => asRoot("true", "bad marker")).toThrow();
		expect(() => asRoot("true", "EOF'; rm -rf /")).toThrow();
	});

	it("rejects a script that contains its own marker line", () => {
		expect(() => asRoot("echo a\nDOKPLOY_ROOT\necho b")).toThrow();
	});
});

describe("summarizeApplyFailures", () => {
	it("passes a run where every server applied", () => {
		expect(
			summarizeApplyFailures({ a: "applied h1", b: "applied h1" }),
		).toBeNull();
	});

	it("fails a run where any server failed, naming it and why", () => {
		const message = summarizeApplyFailures({
			a: "applied h1",
			b: "failed: Applying failed: you must be root",
		});
		expect(message).toContain("1 of 2 server(s) failed");
		expect(message).toContain("b Applying failed: you must be root");
	});

	it("fails a run where every server failed", () => {
		expect(
			summarizeApplyFailures({ a: "failed: x", b: "failed: y" }),
		).toContain("2 of 2");
	});
});
