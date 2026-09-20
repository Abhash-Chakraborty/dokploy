import { and, eq, isNotNull } from "drizzle-orm";
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

const resolveSource = (source: RuleSource, context: CompileContext): string => {
	switch (source.kind) {
		case "any":
			return "any";
		case "cidr":
			return source.value;
		case "mesh":
			return context.meshSubnet ?? "any";
		case "control":
			return context.controlAddress ?? context.meshSubnet ?? "any";
		default:
			return "any";
	}
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
	});
	const policyIds = settings?.policyIds ?? [];
	for (const rule of userRules) {
		const applies =
			rule.serverId === context.serverId ||
			(rule.policyId && policyIds.includes(rule.policyId));
		if (!applies) continue;
		rules.push({
			chain: rule.chain,
			action: rule.action,
			protocol: rule.protocol,
			port: rule.port,
			from: resolveSource(rule.source, context),
			comment: rule.comment || "Custom rule",
			origin: `user:${rule.id}`,
		});
	}

	return rules;
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
	const ssh = rules.filter(
		(rule) =>
			rule.chain === "input" &&
			rule.protocol === "tcp" &&
			(rule.port === String(context.sshPort) ||
				rule.port.includes(`${context.sshPort}`)) &&
			rule.action !== "deny" &&
			rule.action !== "reject",
	);
	if (ssh.length === 0)
		return "No rule allows SSH; that would lock Dokploy out";
	const address = context.controlAddress;
	const reachable = ssh.some(
		(rule) =>
			rule.from === "any" ||
			(context.meshSubnet && rule.from === context.meshSubnet) ||
			(address && rule.from === address),
	);
	return reachable
		? null
		: "No SSH rule covers the address Dokploy connects from";
};
