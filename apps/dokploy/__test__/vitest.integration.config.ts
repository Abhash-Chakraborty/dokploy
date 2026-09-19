import path from "node:path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// Integration tests talk to a real Postgres, so they only run inside the
// sandbox harness (scripts/sandbox/sandbox.sh test:integration), which sets
// SANDBOX_DATABASE_URL to a throwaway database. Unlike the unit config there is
// no DB mock.
const databaseUrl = process.env.SANDBOX_DATABASE_URL;
if (databaseUrl && !new URL(databaseUrl).hostname.startsWith("127.0.0.1")) {
	throw new Error("SANDBOX_DATABASE_URL must point at the loopback sandbox");
}

export default defineConfig({
	test: {
		include: databaseUrl ? ["__test__/integration/**/*.test.ts"] : [],
		passWithNoTests: true,
		pool: "forks",
		fileParallelism: false,
		testTimeout: 180_000,
		hookTimeout: 120_000,
		env: databaseUrl ? { DATABASE_URL: databaseUrl } : {},
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
