import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exit } from "node:process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const ensureLocalAuthEnv = () => {
	const envPath = join(process.cwd(), ".env");
	const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
	const lines = current ? [current.trimEnd()] : [];

	if (!/^BETTER_AUTH_SECRET=/m.test(current)) {
		lines.push(`BETTER_AUTH_SECRET="${randomBytes(48).toString("base64url")}"`);
	}

	if (!/^BETTER_AUTH_URL=/m.test(current)) {
		lines.push(
			`BETTER_AUTH_URL="http://localhost:${process.env.PORT ?? 3000}"`,
		);
	}

	if (lines.length > (current ? 1 : 0)) {
		writeFileSync(envPath, `${lines.join("\n")}\n`);
	}
};

import { setupDirectories } from "@dokploy/server/setup/config-paths";
import { initializePostgres } from "@dokploy/server/setup/postgres-setup";
import { initializeRedis } from "@dokploy/server/setup/redis-setup";
import {
	initializeNetwork,
	initializeSwarm,
} from "@dokploy/server/setup/setup";
import {
	createDefaultMiddlewares,
	createDefaultServerTraefikConfig,
	createDefaultTraefikConfig,
	initializeStandaloneTraefik,
	TRAEFIK_VERSION,
} from "@dokploy/server/setup/traefik-setup";

(async () => {
	try {
		ensureLocalAuthEnv();
		setupDirectories();
		createDefaultMiddlewares();
		await initializeSwarm();
		await initializeNetwork();
		createDefaultTraefikConfig();
		createDefaultServerTraefikConfig();
		await execAsync(`docker pull traefik:v${TRAEFIK_VERSION}`);
		await initializeStandaloneTraefik();
		await initializeRedis();
		await initializePostgres();
		console.log("Dokploy setup completed");
		exit(0);
	} catch (e) {
		console.error("Error in dokploy setup", e);
	}
})();
