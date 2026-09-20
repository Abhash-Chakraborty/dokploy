import { db } from "@dokploy/server/db";
import {
	abhashApproval,
	abhashFirewallRule,
	abhashServerGroup,
	abhashServerMeta,
	environments,
	organization,
	postgres,
	projects,
	server,
	user,
	vaultProvider,
} from "@dokploy/server/db/schema";
import { setCredentialEncryption } from "@dokploy/server/db/schema/abhash-credential";
import {
	createApproval,
	decideApproval,
} from "@dokploy/server/services/abhash/agents/approvals";
import { setKeyPolicy } from "@dokploy/server/services/abhash/agents/service";
import { compileRules } from "@dokploy/server/services/abhash/firewall/compile";
import { defineJob } from "@dokploy/server/services/abhash/jobs";
import {
	assertServerInOrganization,
	assertServiceInOrganization,
} from "@dokploy/server/services/abhash/ownership";
import {
	fingerprint,
	verifyHostKey,
} from "@dokploy/server/services/abhash/ssh/pool";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

process.env.ABHASH_JOBS_PREFIX = `abhash-hardening-${process.pid}`;

const suffix = nanoid(8).toLowerCase();
const mine = `hard-a-${suffix}`;
const theirs = `hard-b-${suffix}`;
const servers: Record<string, string> = {};
let theirDatabase = "";
let myDatabase = "";

const makeOrganization = async (id: string) => {
	await db.insert(user).values({
		id: `${id}-owner`,
		email: `${id}@sandbox.test`,
		emailVerified: true,
		expirationDate: new Date().toISOString(),
		createdAt2: new Date().toISOString(),
		updatedAt: new Date(),
	} as never);
	await db.insert(organization).values({
		id,
		name: id,
		ownerId: `${id}-owner`,
		createdAt: new Date(),
	});
};

const makeServer = async (organizationId: string, name: string, ip: string) => {
	const [row] = await db
		.insert(server)
		.values({
			name,
			ipAddress: ip,
			port: 22,
			username: "root",
			appName: `${name}-${suffix}`,
			organizationId,
			serverStatus: "active",
			createdAt: new Date().toISOString(),
		} as never)
		.returning();
	servers[name] = row?.serverId as string;
	return servers[name] as string;
};

const makeDatabase = async (organizationId: string) => {
	const [project] = await db
		.insert(projects)
		.values({ name: `p-${organizationId}`, organizationId })
		.returning();
	const [environment] = await db
		.insert(environments)
		.values({ name: "production", projectId: project?.projectId as string })
		.returning();
	const id = `pg-${organizationId}`;
	await db.insert(postgres).values({
		environmentId: environment?.environmentId,
		postgresId: id,
		name: id,
		appName: id,
		databaseName: "app",
		databaseUser: "app",
		databasePassword: "x",
		dockerImage: "postgres:16-alpine",
		applicationStatus: "done",
		createdAt: new Date().toISOString(),
	} as never);
	return id;
};

beforeAll(async () => {
	await makeOrganization(mine);
	await makeOrganization(theirs);
	await makeServer(mine, "edge", "198.51.100.10");
	await makeServer(mine, "worker-1", "198.51.100.21");
	await makeServer(mine, "worker-2", "198.51.100.22");
	await makeServer(theirs, "foreign", "203.0.113.99");
	myDatabase = await makeDatabase(mine);
	theirDatabase = await makeDatabase(theirs);
});

afterAll(async () => {
	setCredentialEncryption(false);
	for (const id of [mine, theirs]) {
		await db.delete(organization).where(eq(organization.id, id));
		await db.delete(user).where(eq(user.id, `${id}-owner`));
	}
});

describe("an id is not a permission", () => {
	it("finds our own server and database", async () => {
		await expect(
			assertServerInOrganization(mine, servers.edge),
		).resolves.toBeUndefined();
		await expect(
			assertServiceInOrganization(mine, "postgres", myDatabase),
		).resolves.toBeDefined();
	});

	it("treats the Dokploy host, which has no id, as shared", async () => {
		await expect(
			assertServerInOrganization(mine, null),
		).resolves.toBeUndefined();
	});

	it("answers 'not found' for another organization's", async () => {
		await expect(
			assertServerInOrganization(mine, servers.foreign),
		).rejects.toThrow("Server not found");
		await expect(
			assertServiceInOrganization(mine, "postgres", theirDatabase),
		).rejects.toThrow("Service not found");
		await expect(
			assertServiceInOrganization(mine, "postgres", "no-such-id"),
		).rejects.toThrow("Service not found");
	});

	it("will not rewrite the restrictions of a key it does not own", async () => {
		await expect(
			setKeyPolicy(mine, "a-key-from-somewhere-else", {
				readOnly: false,
				allow: [],
				ipAllowList: [],
				approvalMode: "none",
			} as never),
		).rejects.toThrow("Key not found");
	});
});

describe("firewall rule sources", () => {
	const context = () => ({
		serverId: servers.edge as string,
		organizationId: mine,
		sshPort: 22,
		meshSubnet: null,
		controlAddress: null,
	});
	const userRules = async () =>
		(await compileRules(context())).filter((rule) =>
			rule.origin.startsWith("user:"),
		);
	const addRule = async (values: Record<string, unknown>) => {
		const [row] = await db
			.insert(abhashFirewallRule)
			.values({
				organizationId: mine,
				serverId: servers.edge,
				port: "5432",
				...values,
			} as never)
			.returning();
		return row?.id as string;
	};

	it("survive the database: a range stays that range", async () => {
		const id = await addRule({
			source: { kind: "cidr", value: "10.0.0.0/8" },
		});
		const [stored] = await db.execute(
			sql`select source from abhash_firewall_rule where id = ${id}`,
		);
		expect(stored?.source).toBe('{"kind":"cidr","value":"10.0.0.0/8"}');
		const rules = await userRules();
		expect(rules.map((rule) => rule.from)).toEqual(["10.0.0.0/8"]);
	});

	it("drop a rule whose source cannot be read, instead of opening it", async () => {
		await db.delete(abhashFirewallRule);
		const id = await addRule({ source: { kind: "any" } });
		// What the old column type wrote for every source.
		await db.execute(
			sql`update abhash_firewall_rule set source = '[object Object]' where id = ${id}`,
		);
		expect(await userRules()).toEqual([]);
	});

	it("drop a range that is not one, however it got in", async () => {
		await db.delete(abhashFirewallRule);
		await addRule({
			source: { kind: "cidr", value: "10.0.0.0/8; rm -rf /" },
		});
		expect(await userRules()).toEqual([]);
	});

	it("resolve a group to its members, and an empty group to nothing", async () => {
		await db.delete(abhashFirewallRule);
		const [group] = await db
			.insert(abhashServerGroup)
			.values({ organizationId: mine, name: `workers-${suffix}` })
			.returning();
		const [empty] = await db
			.insert(abhashServerGroup)
			.values({ organizationId: mine, name: `empty-${suffix}` })
			.returning();
		for (const name of ["worker-1", "worker-2"]) {
			await db.insert(abhashServerMeta).values({
				serverId: servers[name] as string,
				organizationId: mine,
				groupId: group?.id,
			});
		}
		await addRule({ source: { kind: "group", groupId: group?.id } });
		await addRule({
			port: "6379",
			source: { kind: "group", groupId: empty?.id },
		});
		await addRule({
			port: "27017",
			source: { kind: "group", groupId: "no-such-group" },
		});

		const rules = await userRules();
		expect(rules.map((rule) => `${rule.port} ${rule.from}`).sort()).toEqual([
			"5432 198.51.100.21",
			"5432 198.51.100.22",
		]);
		expect(rules.some((rule) => rule.from === "any")).toBe(false);
	});

	it("put the rules you wrote first, in priority order", async () => {
		await db.delete(abhashFirewallRule);
		await addRule({
			port: "22",
			action: "allow",
			priority: 200,
			source: { kind: "cidr", value: "198.51.100.0/24" },
		});
		await addRule({
			port: "22",
			action: "deny",
			priority: 10,
			source: { kind: "cidr", value: "198.51.100.66" },
		});
		const rules = await compileRules(context());
		const onSsh = rules.filter((rule) => rule.port === "22");
		expect(onSsh.map((rule) => `${rule.action} ${rule.from}`)).toEqual([
			"deny 198.51.100.66",
			"allow 198.51.100.0/24",
			"limit any",
		]);
	});
});

describe("an approval", () => {
	let runs = 0;
	defineJob({
		type: "test.hardening-approved",
		queue: "abhash-infra",
		input: z.object({}),
		title: () => "approved once",
		destructive: true,
		run: async () => {
			runs++;
			return null;
		},
	});
	const decidedBy = {
		id: `${mine}-owner`,
		email: "o@sandbox.test",
		role: "owner",
	};

	const live = process.env.REDIS_URL?.startsWith("redis://127.0.0.1:")
		? it
		: it.skip;

	live("granted twice at once runs its job once", async () => {
		const approval = await createApproval({
			organizationId: mine,
			actor: { type: "agent", id: "a1", name: "agent" } as never,
			operation: "test.hardening-approved",
			summary: "approved once",
			payload: {},
		});
		const outcomes = await Promise.allSettled(
			[1, 2, 3, 4].map(() =>
				decideApproval({
					organizationId: mine,
					id: approval.id,
					approve: true,
					decidedBy,
				}),
			),
		);
		expect(
			outcomes.filter((outcome) => outcome.status === "fulfilled"),
		).toHaveLength(1);
		for (const outcome of outcomes) {
			if (outcome.status === "rejected") {
				expect(String(outcome.reason)).toMatch(/already/);
			}
		}
		const row = await db.query.abhashApproval.findFirst({
			where: eq(abhashApproval.id, approval.id),
		});
		expect(row?.status).toBe("executed");
		expect(row?.jobId).toBeTruthy();
		expect(runs).toBeLessThanOrEqual(1);
	});

	it("cannot be rejected after it was approved", async () => {
		const approval = await createApproval({
			organizationId: mine,
			actor: { type: "agent", id: "a1", name: "agent" } as never,
			operation: "test.hardening-approved",
			summary: "rejected",
			payload: {},
		});
		await decideApproval({
			organizationId: mine,
			id: approval.id,
			approve: false,
			decidedBy,
		});
		await expect(
			decideApproval({
				organizationId: mine,
				id: approval.id,
				approve: true,
				decidedBy,
			}),
		).rejects.toThrow(/already rejected/);
	});
});

describe("trust on first use", () => {
	const first = Buffer.from("first-host-key");
	const second = Buffer.from("a-different-host-key");

	it("pins the first key even when nothing had made a row yet", async () => {
		const id = servers["worker-1"] as string;
		await db.delete(abhashServerMeta).where(eq(abhashServerMeta.serverId, id));
		expect(await verifyHostKey(id, first)).toBe(true);
		const row = await db.query.abhashServerMeta.findFirst({
			where: eq(abhashServerMeta.serverId, id),
		});
		expect(row?.hostKey).toBe(fingerprint(first));
	});

	it("then refuses any other, and says so on the server", async () => {
		const id = servers["worker-1"] as string;
		expect(await verifyHostKey(id, second)).toBe(false);
		expect(await verifyHostKey(id, first)).toBe(true);
		const row = await db.query.abhashServerMeta.findFirst({
			where: eq(abhashServerMeta.serverId, id),
		});
		expect(row?.hostKeyMismatch).toBe(true);
	});

	it("lets only one of two racing first connections pin", async () => {
		const id = servers["worker-2"] as string;
		await db.delete(abhashServerMeta).where(eq(abhashServerMeta.serverId, id));
		const results = await Promise.all([
			verifyHostKey(id, first),
			verifyHostKey(id, second),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
	});

	it("refuses a server that does not exist", async () => {
		expect(await verifyHostKey("no-such-server", first)).toBe(false);
	});
});

describe("an encrypted JSON credential", () => {
	it("is written as ciphertext and read back whole", async () => {
		setCredentialEncryption(true);
		const config = { address: "https://vault.test", token: "s.very-secret" };
		const [row] = await db
			.insert(vaultProvider)
			.values({
				name: `hc-${suffix}`,
				providerType: "hashicorp",
				config,
				organizationId: mine,
			} as never)
			.returning();
		const [stored] = await db.execute(
			sql`select config::text as raw from vault_provider where "vaultProviderId" = ${row?.vaultProviderId}`,
		);
		expect(String(stored?.raw)).toContain("enc:v1:");
		expect(String(stored?.raw)).not.toContain("very-secret");
		const back = await db.query.vaultProvider.findFirst({
			where: eq(vaultProvider.vaultProviderId, row?.vaultProviderId as string),
		});
		expect(back?.config).toEqual(config);
	});
});
