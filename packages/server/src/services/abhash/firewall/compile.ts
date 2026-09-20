import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../../../db";
import {
	abhashFirewallRule,
	abhashServerFirewall,
	abhashServerMesh,
	abhashServerMeta,
	mariadb,
	mongo,
	mysql,
	postgres,
	type RuleAction,
	type RuleChain,
	type RuleProtocol,
	type RuleSource,
	redis,
	server,
} from "../../../db/schema";
import { activeProvider } from "../mesh/service";
import { cidrContains, isCidr } from "./cidr";

export type CompiledRule = {
	chain: RuleChain;
	action: RuleAction;
	protocol: RuleProtocol;
	port: string;
	/** Already resolved to something ufw understands. */
	from: string;
	interface?: string;
	comment: string;
	/** `auto:<reason>` for a derived rule, `user:<id>` for one you wrote. */
	origin: string;
};

export type CompileContext = {
	serverId: string;
	organizationId: string;
	/** The address Dokploy connects from, so a rule cannot lock it out. */
	controlAddress?: string | null;
	meshSubnet?: string | null;
	sshPort: number;
};

// Both providers hand out addresses from the CGNAT range.
const MESH_DEFAULT_SUBNET = "100.64.0.0/10";

/**
 * The addresses a source stands for. An empty list means the rule matches
 * nothing and is left out: a source that cannot be resolved must never
 * widen into "anywhere".
 */
const resolveSource = async (
	source: RuleSource,
	context: CompileContext,
): Promise<string[]> => {
	switch (source.kind) {
		case "any":
			return ["any"];
		case "cidr":
			return isCidr(source.value) ? [source.value] : [];
		case "mesh":
			return context.meshSubnet ? [context.meshSubnet] : [];
		case "control":
			return context.controlAddress
				? [context.controlAddress]
				: context.meshSubnet
					? [context.meshSubnet]
					: [];
		case "group":
			return groupAddresses(context.organizationId, source.groupId);
		default:
			return [];
	}
};

/** Every address the servers of a group can be reached or seen at. */
const groupAddresses = async (organizationId: string, groupId: string) => {
	const members = await db.query.abhashServerMeta.findMany({
		where: and(
			eq(abhashServerMeta.organizationId, organizationId),
			eq(abhashServerMeta.groupId, groupId),
		),
		columns: { serverId: true },
	});
	const ids = members.map((member) => member.serverId);
	if (ids.length === 0) return [];
	const [servers, peers] = await Promise.all([
		db.query.server.findMany({
			where: inArray(server.serverId, ids),
			columns: { ipAddress: true },
		}),
		db.query.abhashServerMesh.findMany({
			where: inArray(abhashServerMesh.serverId, ids),
			columns: { meshIp: true },
		}),
	]);
	const addresses = [
		...servers.map((row) => row.ipAddress),
		...peers.map((row) => row.meshIp),
	].filter((address): address is string => !!address && isCidr(address));
	return [...new Set(addresses)];
};

/** Databases only accept traffic from where their own setting says. */
const databasePorts = async (serverId: string) => {
	const tables = [postgres, mysql, mariadb, mongo, redis] as const;
	const ports: { port: number; name: string }[] = [];
	for (const table of tables) {
		const rows = await db
			.select({
				externalPort: table.externalPort,
				appName: table.appName,
			})
			.from(table)
			.where(and(eq(table.serverId, serverId), isNotNull(table.externalPort)));
		for (const row of rows) {
			if (row.externalPort) {
				ports.push({ port: row.externalPort, name: row.appName });
			}
		}
	}
	return ports;
};

/**
 * Turns "what is deployed here" into rules, then adds the ones you wrote.
 * Auto rules carry a reason so the UI can explain them and you can switch
 * any of them off.
 */
export const compileRules = async (
	context: CompileContext,
): Promise<CompiledRule[]> => {
	const settings = await db.query.abhashServerFirewall.findFirst({
		where: eq(abhashServerFirewall.serverId, context.serverId),
	});
	const disabled = new Set(settings?.disabledAutoRules ?? []);
	const rules: CompiledRule[] = [];
	const auto = (
		reason: string,
		rule: Omit<CompiledRule, "origin" | "comment"> & { comment?: string },
	) => {
		if (disabled.has(reason)) return;
		rules.push({
			...rule,
			comment: rule.comment ?? reason,
			origin: `auto:${reason}`,
		});
	};

	// SSH: from the mesh when there is one, otherwise rate-limited from
	// anywhere, so a server is never left unreachable.
	auto("ssh", {
		chain: "input",
		action: context.meshSubnet ? "allow" : "limit",
		protocol: "tcp",
		port: String(context.sshPort),
		from: context.meshSubnet ?? "any",
		comment: context.meshSubnet ? "SSH from the mesh" : "SSH (rate limited)",
	});

	const meta = await db.query.abhashServerMeta.findFirst({
		where: eq(abhashServerMeta.serverId, context.serverId),
	});
	const facts = meta?.facts;

	// Traefik runs on every deploy server, so HTTP and HTTPS stay open.
	const row = await db.query.server.findFirst({
		where: eq(server.serverId, context.serverId),
		columns: { serverType: true },
	});
	if (row?.serverType !== "build") {
		auto("web", {
			chain: "input",
			action: "allow",
			protocol: "tcp",
			port: "80",
			from: "any",
			comment: "HTTP",
		});
		auto("web-tls", {
			chain: "input",
			action: "allow",
			protocol: "tcp",
			port: "443",
			from: "any",
			comment: "HTTPS",
		});
	}

	// Swarm only ever talks to other servers, never to the internet.
	if (facts?.swarm === "active") {
		const from = context.meshSubnet ?? "any";
		for (const [protocol, ports] of [
			["tcp", ["2377", "7946"]],
			["udp", ["7946", "4789"]],
		] as const) {
			for (const port of ports) {
				auto("swarm", {
					chain: "input",
					action: "allow",
					protocol,
					port,
					from,
					comment: "Docker Swarm between servers",
				});
			}
		}
	}

	// The monitoring agent answers only to Dokploy.
	auto("monitoring", {
		chain: "input",
		action: "allow",
		protocol: "tcp",
		port: "4500",
		from: context.controlAddress ?? context.meshSubnet ?? "any",
		comment: "Metrics agent",
	});

	if (context.meshSubnet) {
		const provider = await activeProvider(context.organizationId);
		auto("mesh", {
			chain: "input",
			action: "allow",
			protocol: "udp",
			port: provider?.kind === "headscale" ? "41641" : "51820",
			from: "any",
			comment: "Mesh client",
		});
	}

	// A database with a published port: reachable from the mesh only, unless
	// a rule you wrote says otherwise.
	for (const database of await databasePorts(context.serverId)) {
		auto(`database:${database.name}`, {
			chain: "docker",
			action: "allow",
			protocol: "tcp",
			port: String(database.port),
			from: context.meshSubnet ?? "any",
			comment: `${database.name} (published port)`,
		});
	}

	const userRules = await db.query.abhashFirewallRule.findMany({
		where: and(
			eq(abhashFirewallRule.organizationId, context.organizationId),
			eq(abhashFirewallRule.enabled, true),
		),
		orderBy: [abhashFirewallRule.priority, abhashFirewallRule.createdAt],
	});
	const policyIds = settings?.policyIds ?? [];
	const written: CompiledRule[] = [];
	for (const rule of userRules) {
		const applies =
			rule.serverId === context.serverId ||
			(rule.policyId && policyIds.includes(rule.policyId));
		if (!applies) continue;
		for (const from of await resolveSource(rule.source, context)) {
			written.push({
				chain: rule.chain,
				action: rule.action,
				protocol: rule.protocol,
				port: rule.port,
				from,
				comment: rule.comment || "Custom rule",
				origin: `user:${rule.id}`,
			});
		}
	}

	// Both ufw and the managed chain stop at the first rule that matches, so
	// the rules you wrote go first, lowest priority number first. That is what
	// lets a deny of yours override an allow that was derived.
	return [...written, ...rules];
};

/**
 * The mesh range a server is on, used for "from the mesh" rules. Both
 * providers hand out addresses from the CGNAT range, and the server's own
 * address decides the /16 so the rule stays tight.
 */
export const meshSubnetFor = async (serverId: string) => {
	const row = await db.query.abhashServerMesh.findFirst({
		where: eq(abhashServerMesh.serverId, serverId),
	});
	if (!row?.meshIp) return null;
	const parts = row.meshIp.split(".");
	if (parts.length !== 4) return MESH_DEFAULT_SUBNET;
	return `${parts[0]}.${parts[1]}.0.0/16`;
};

/** Nothing may be applied that would cut the connection Dokploy uses. */
export const wouldLockOut = (
	rules: CompiledRule[],
	context: CompileContext,
) => {
	const address = context.controlAddress;
	// Without a known address, the mesh range stands in for where Dokploy is.
	const origin = address ?? context.meshSubnet;
	const covers = (rule: CompiledRule) =>
		rule.from === "any" || (!!origin && cidrContains(rule.from, origin));
	const [low, high] = [String(context.sshPort), String(context.sshPort)];
	const onSsh = (rule: CompiledRule) => {
		const [start, end] = rule.port.split(":");
		return (
			rule.chain === "input" &&
			rule.protocol === "tcp" &&
			Number(start) <= Number(low) &&
			Number(end ?? start) >= Number(high)
		);
	};
	// First match wins on the server, so it has to win here too: an allow
	// further down does not help once a deny above it has caught Dokploy.
	const first = rules.find((rule) => onSsh(rule) && covers(rule));
	if (!first) {
		return rules.some(onSsh)
			? "No SSH rule covers the address Dokploy connects from"
			: "No rule allows SSH; that would lock Dokploy out";
	}
	return first.action === "deny" || first.action === "reject"
		? "A rule blocks SSH from the address Dokploy connects from before any rule allows it"
		: null;
};
