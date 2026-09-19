import { eq } from "drizzle-orm";
import { IS_CLOUD } from "../../constants";
import { db } from "../../db";
import { server } from "../../db/schema";
import { getWebServerSettings } from "../web-server-settings";

// Development default of the monitoring agent (see pages/dashboard/monitoring).
const DEV_ORIGINS =
	process.env.NODE_ENV === "production" ? [] : ["http://localhost:3001"];

/**
 * Origins of the monitoring agents this organization runs: the Dokploy
 * server's and each of its remote servers'. Endpoints that fetch metrics on
 * the caller's behalf accept only these, so they cannot be pointed at an
 * arbitrary host (server-side request forgery).
 */
export const metricsOrigins = async (organizationId: string) => {
	const origins = new Set<string>(DEV_ORIGINS);
	const add = (host: string | null | undefined, port: unknown) => {
		if (!host || !port) return;
		try {
			origins.add(new URL(`http://${host}:${port}`).origin);
		} catch {}
	};
	if (!IS_CLOUD) {
		const settings = await getWebServerSettings();
		add(settings?.serverIp, settings?.metricsConfig?.server?.port);
	}
	const servers = await db.query.server.findMany({
		where: eq(server.organizationId, organizationId),
		columns: { ipAddress: true, metricsConfig: true },
	});
	for (const s of servers) add(s.ipAddress, s.metricsConfig?.server?.port);
	return origins;
};

export const isMetricsUrlAllowed = async (
	url: string,
	organizationId: string,
) => {
	let origin: string;
	try {
		origin = new URL(url).origin;
	} catch {
		return false;
	}
	return (await metricsOrigins(organizationId)).has(origin);
};
