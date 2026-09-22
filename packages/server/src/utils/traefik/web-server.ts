import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@dokploy/server/constants";
import type { webServerSettings } from "@dokploy/server/db/schema/web-server-settings";
import {
	dashboardMiddlewareRefs,
	isManagedRef,
} from "@dokploy/server/services/abhash/middlewares/refs";
import { parse, stringify } from "yaml";
import {
	loadOrCreateConfig,
	removeTraefikConfig,
	writeTraefikConfig,
} from "./application";
import type { FileConfig } from "./file-types";
import type { MainTraefikConfig } from "./types";

export const updateServerTraefik = (
	settings: typeof webServerSettings.$inferSelect | null,
	newHost: string | null,
) => {
	const { https, certificateType } = settings || {};
	const appName = "dokploy";
	const config: FileConfig = loadOrCreateConfig(appName);

	config.http = config.http || { routers: {}, services: {} };
	config.http.routers = config.http.routers || {};
	config.http.services = config.http.services || {};

	// Get or create router config, but always update the rule with newHost
	const currentRouterConfig = config.http.routers[`${appName}-router-app`] || {
		service: `${appName}-service-app`,
		entryPoints: ["web"],
		rule: `Host(\`${newHost}\`)`,
	};

	// Always update the rule with the new host
	if (newHost) {
		currentRouterConfig.rule = `Host(\`${newHost}\`)`;
	}

	config.http.routers[`${appName}-router-app`] = currentRouterConfig;

	config.http.services = {
		...config.http.services,
		[`${appName}-service-app`]: {
			loadBalancer: {
				servers: [
					{
						url: `http://dokploy:${process.env.PORT || 3000}`,
					},
				],
				passHostHeader: true,
			},
		},
	};

	// Middlewares attached from the Middlewares page survive a settings save.
	const managed = [
		...(currentRouterConfig.middlewares ?? []),
		...(config.http.routers[`${appName}-router-app-secure`]?.middlewares ?? []),
	].filter(
		(ref, index, all) => isManagedRef(ref) && all.indexOf(ref) === index,
	);

	if (https) {
		currentRouterConfig.middlewares = ["redirect-to-https"];

		if (certificateType === "letsencrypt") {
			config.http.routers[`${appName}-router-app-secure`] = {
				rule: `Host(\`${newHost}\`)`,
				service: `${appName}-service-app`,
				entryPoints: ["websecure"],
				tls: { certResolver: "letsencrypt" },
				...(managed.length ? { middlewares: managed } : {}),
			};
		} else {
			config.http.routers[`${appName}-router-app-secure`] = {
				rule: `Host(\`${newHost}\`)`,
				service: `${appName}-service-app`,
				entryPoints: ["websecure"],
				...(managed.length ? { middlewares: managed } : {}),
			};
		}
	} else {
		delete config.http.routers[`${appName}-router-app-secure`];
		currentRouterConfig.middlewares = managed;
	}

	if (newHost) {
		writeTraefikConfig(config, appName);
	} else {
		removeTraefikConfig(appName);
	}
};

export const updateLetsEncryptEmail = (newEmail: string | null) => {
	try {
		if (!newEmail) return;
		const { MAIN_TRAEFIK_PATH } = paths();
		const configPath = join(MAIN_TRAEFIK_PATH, "traefik.yml");
		const configContent = readFileSync(configPath, "utf8");
		const config = parse(configContent) as MainTraefikConfig;
		if (config?.certificatesResolvers?.letsencrypt?.acme) {
			config.certificatesResolvers.letsencrypt.acme.email = newEmail;
		} else {
			throw new Error("Invalid Let's Encrypt configuration structure.");
		}
		const newYamlContent = stringify(config);
		writeFileSync(configPath, newYamlContent, "utf8");
	} catch (error) {
		throw error;
	}
};

export const readMainConfig = () => {
	const { MAIN_TRAEFIK_PATH } = paths();
	const configPath = join(MAIN_TRAEFIK_PATH, "traefik.yml");
	if (existsSync(configPath)) {
		const yamlStr = readFileSync(configPath, "utf8");
		return yamlStr;
	}
	return null;
};

export const writeMainConfig = (traefikConfig: string) => {
	try {
		const { MAIN_TRAEFIK_PATH } = paths();
		const configPath = join(MAIN_TRAEFIK_PATH, "traefik.yml");
		writeFileSync(configPath, traefikConfig, "utf8");
	} catch (e) {
		console.error("Error saving the YAML config file:", e);
	}
};

/**
 * Puts the middlewares marked "Also the Dokploy dashboard" on the dashboard's
 * routers. With HTTPS the plain router only redirects, so they go on the
 * secure one; without it they go on the only router there is.
 */
export const applyDashboardMiddlewares = async () => {
	const { DYNAMIC_TRAEFIK_PATH } = paths();
	if (!existsSync(join(DYNAMIC_TRAEFIK_PATH, "dokploy.yml"))) return;
	const refs = await dashboardMiddlewareRefs();
	const config: FileConfig = loadOrCreateConfig("dokploy");
	const routers = config.http?.routers ?? {};
	const plain = routers["dokploy-router-app"];
	const secure = routers["dokploy-router-app-secure"];
	const keep = (list: string[] | undefined) =>
		(list ?? []).filter((ref) => !isManagedRef(ref));
	if (secure) {
		secure.middlewares = [...keep(secure.middlewares), ...refs];
	} else if (plain) {
		plain.middlewares = [...keep(plain.middlewares), ...refs];
	}
	writeTraefikConfig(config, "dokploy");
};
