import path from "node:path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// This repository is developed on a production Docker host, and several suites
// deploy real containers and Swarm services. Unless the sandbox harness hands
// us a throwaway daemon (scripts/sandbox/sandbox.sh test), every Docker client
// -- the CLI, nixpacks/pack and dockerode -- is pointed at a closed port, so
// those suites skip instead of reaching the host daemon.
const sandboxDockerHost = process.env.SANDBOX_DOCKER_HOST;
if (sandboxDockerHost && !sandboxDockerHost.startsWith("tcp://127.0.0.1:")) {
	throw new Error(
		`SANDBOX_DOCKER_HOST must be a loopback tcp:// address, got ${sandboxDockerHost}`,
	);
}
const dockerTarget = new URL(sandboxDockerHost ?? "tcp://127.0.0.1:1");
const dockerEnv = {
	DOCKER_HOST: dockerTarget.href.replace(/\/$/, ""),
	DOKPLOY_DOCKER_HOST: dockerTarget.hostname,
	DOKPLOY_DOCKER_PORT: dockerTarget.port,
};

export default defineConfig({
	test: {
		include: ["__test__/**/*.test.ts"], // Incluir solo los archivos de test en el directorio __test__
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"**/.docker/**",
			...(sandboxDockerHost ? [] : ["**/*.real.test.ts"]),
		],
		pool: "forks",
		env: dockerEnv,
		setupFiles: [path.resolve(__dirname, "setup.ts")],
	},
	define: {
		"process.env": {
			NODE: "test",
			GITHUB_CLIENT_ID: "test",
			GITHUB_CLIENT_SECRET: "test",
			GOOGLE_CLIENT_ID: "test",
			GOOGLE_CLIENT_SECRET: "test",
			...dockerEnv,
		},
	},
	plugins: [
		tsconfigPaths({
			projects: [path.resolve(__dirname, "../tsconfig.json")],
		}),
	],
	resolve: {
		alias: {
			"@dokploy/server": path.resolve(
				__dirname,
				"../../../packages/server/src",
			),
		},
	},
});
