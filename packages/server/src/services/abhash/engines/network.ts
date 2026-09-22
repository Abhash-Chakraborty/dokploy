import { parse, stringify } from "yaml";

/**
 * Engine stacks advertise `<name>-<service>` as their address, but a raw
 * compose stack only joins its own default network, where nothing outside it
 * can resolve that name. Every service therefore also joins dokploy-network
 * under exactly that alias, so other Dokploy services reach it as advertised.
 */
export const attachToDokployNetwork = (composeFile: string, name: string) => {
	const doc = parse(composeFile) as {
		services?: Record<string, { networks?: unknown }>;
		networks?: Record<string, unknown>;
	};
	for (const [service, spec] of Object.entries(doc.services ?? {})) {
		const existing = Array.isArray(spec.networks)
			? Object.fromEntries(spec.networks.map((n: string) => [n, {}]))
			: ((spec.networks as Record<string, unknown> | undefined) ?? {});
		spec.networks = {
			default: {},
			...existing,
			"dokploy-network": { aliases: [`${name}-${service}`] },
		};
	}
	doc.networks = {
		...(doc.networks ?? {}),
		"dokploy-network": { external: true },
	};
	return stringify(doc);
};
