import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { KEEP_DOCKER_ENV } from "@dokploy/server/utils/process/docker-env";
import { describe, expect, it } from "vitest";

const run = (env: Record<string, string>) =>
	execFileSync(
		"sh",
		["-c", `env -i PATH="$PATH" ${KEEP_DOCKER_ENV} sh -c 'env | sort'`],
		{
			env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...env },
			encoding: "utf8",
		},
	);

describe("compose commands keep the Docker client's target", () => {
	it("passes DOCKER_HOST through env -i", () => {
		const out = run({ DOCKER_HOST: "tcp://127.0.0.1:2375", LEAK: "no" });
		expect(out).toContain("DOCKER_HOST=tcp://127.0.0.1:2375");
		expect(out).not.toContain("LEAK=");
	});

	it("adds nothing when the variables are unset, as in production", () => {
		expect(run({})).not.toContain("DOCKER_");
	});

	// Found when a sandbox deploy of a compose stack landed on the host's
	// Docker: every `env -i` in front of docker must carry the target along.
	it("is used by every env -i docker command in the server package", () => {
		const root = join(__dirname, "../../../../packages/server/src");
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir)) {
				const path = join(dir, entry);
				if (statSync(path).isDirectory()) walk(path);
				else if (path.endsWith(".ts")) {
					readFileSync(path, "utf8")
						.split("\n")
						.forEach((line, index) => {
							if (
								/env -i\b/.test(line) &&
								/docker/.test(line) &&
								!line.includes("KEEP_DOCKER_ENV")
							) {
								offenders.push(`${path}:${index + 1}`);
							}
						});
				}
			}
		};
		walk(root);
		expect(offenders).toEqual([]);
	});
});
