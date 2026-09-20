import { readFileSync } from "node:fs";
import { db } from "@dokploy/server/db";
import {
	abhashAnsibleProject,
	abhashAnsibleTemplate,
	organization,
	server,
	sshKeys,
	user,
} from "@dokploy/server/db/schema";
import {
	PING_PLAYBOOK,
	parseRecap,
	renderInventory,
	resolveTargets,
	runPlaybook,
	scanHostKey,
} from "@dokploy/server/services/abhash/ansible";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// scripts/sandbox/sandbox.sh up --fleet publishes these.
const fleet = (process.env.SANDBOX_FLEET_HOSTS ?? "")
	.split(",")
	.filter(Boolean)
	.map((entry) => {
		const [name, address] = entry.split("=");
		return { name: name as string, address: address as string };
	});
const keyPath = process.env.SANDBOX_FLEET_KEY;
const run = fleet.length > 0 && keyPath ? describe : describe.skip;

const suffix = nanoid(8);
const organizationId = `ansible-${suffix}`;
const ownerId = `${organizationId}-owner`;

beforeAll(async () => {
	if (!fleet.length || !keyPath) return;
	const privateKey = readFileSync(keyPath, "utf8");
	await db.insert(user).values({
		id: ownerId,
		email: `${ownerId}@sandbox.test`,
		emailVerified: true,
		expirationDate: new Date().toISOString(),
		createdAt2: new Date().toISOString(),
		updatedAt: new Date(),
	} as never);
	await db.insert(organization).values({
		id: organizationId,
		name: `Ansible ${suffix}`,
		ownerId,
		createdAt: new Date(),
	});
	const [key] = await db
		.insert(sshKeys)
		.values({
			name: `fleet-${suffix}`,
			privateKey,
			publicKey: readFileSync(`${keyPath}.pub`, "utf8"),
			organizationId,
		})
		.returning();
	for (const host of fleet) {
		await db.insert(server).values({
			name: host.name,
			ipAddress: host.address,
			port: 22,
			username: "root",
			appName: `${host.name}-${suffix}`,
			sshKeyId: key?.sshKeyId,
			organizationId,
			serverStatus: "active",
			createdAt: new Date().toISOString(),
		} as never);
	}
});

afterAll(async () => {
	await db.delete(organization).where(eq(organization.id, organizationId));
	await db.delete(user).where(eq(user.id, ownerId));
});

describe("ansible recap parsing", () => {
	it("reads per-host counts", () => {
		const output = [
			"PLAY RECAP *********************************************************",
			"fleet-1                    : ok=2    changed=1    unreachable=0    failed=0    skipped=0",
			"fleet-2                    : ok=1    changed=0    unreachable=1    failed=0    skipped=0",
		].join("\n");
		expect(parseRecap(output)).toEqual([
			{ host: "fleet-1", ok: 2, changed: 1, unreachable: 0, failed: 0 },
			{ host: "fleet-2", ok: 1, changed: 0, unreachable: 1, failed: 0 },
		]);
	});

	it("renders an inventory with one line per server", () => {
		const text = renderInventory([
			{
				serverId: "s1",
				name: "web",
				address: "10.0.0.1",
				port: 22,
				user: "root",
				privateKey: "k",
			},
		]);
		expect(text).toContain("[dokploy]");
		expect(text).toContain("web ansible_host=10.0.0.1 ansible_port=22");
		expect(text).not.toContain("privateKey");
	});
});

run("ansible against the sandbox fleet", () => {
	it("resolves the servers into an inventory", async () => {
		const hosts = await resolveTargets(organizationId, {
			serverIds: [],
			all: true,
		});
		expect(hosts).toHaveLength(fleet.length);
	});

	it("reads a real host key", async () => {
		const [host] = await resolveTargets(organizationId, {
			serverIds: [],
			all: true,
		});
		const line = await scanHostKey(host!);
		expect(line).toMatch(/^\d+\.\d+\.\d+\.\d+ ssh-(ed25519|rsa|ecdsa)/);
	});

	it("runs a playbook on every server and reports the recap", async () => {
		const hosts = await resolveTargets(organizationId, {
			serverIds: [],
			all: true,
		});
		const lines: string[] = [];
		const result = await runPlaybook({
			files: { "ping.yml": PING_PLAYBOOK },
			playbook: "ping.yml",
			hosts,
			become: false,
			log: (line) => {
				lines.push(line);
			},
		});
		expect(result.exitCode, lines.slice(-25).join("\n")).toBe(0);
		expect(result.recap).toHaveLength(fleet.length);
		expect(result.recap.every((host) => host.failed === 0)).toBe(true);
		expect(lines.join("\n")).toContain("Ubuntu");
	}, 300_000);

	it("keeps check mode from changing anything, and reports the change", async () => {
		const hosts = await resolveTargets(organizationId, {
			serverIds: [],
			all: true,
		});
		const playbook = `- hosts: dokploy
  gather_facts: false
  tasks:
    - name: A file that check mode must not create
      ansible.builtin.copy:
        dest: /tmp/abhash-check-${suffix}
        content: "written"
        mode: "0600"
`;
		const checked = await runPlaybook({
			files: { "change.yml": playbook },
			playbook: "change.yml",
			hosts,
			checkMode: true,
			become: false,
			log: () => {},
		});
		expect(checked.exitCode).toBe(0);
		expect(checked.changed).toBe(true);

		const applied = await runPlaybook({
			files: { "change.yml": playbook },
			playbook: "change.yml",
			hosts,
			checkMode: false,
			become: false,
			log: () => {},
		});
		expect(applied.changed).toBe(true);

		// Running it again changes nothing: the roles must be idempotent.
		const again = await runPlaybook({
			files: { "change.yml": playbook },
			playbook: "change.yml",
			hosts,
			checkMode: false,
			become: false,
			log: () => {},
		});
		expect(again.changed).toBe(false);
	}, 600_000);

	it("stores a project and template that can be run", async () => {
		const [project] = await db
			.insert(abhashAnsibleProject)
			.values({
				organizationId,
				name: "Starter",
				files: { "ping.yml": PING_PLAYBOOK },
			})
			.returning();
		const [template] = await db
			.insert(abhashAnsibleTemplate)
			.values({
				organizationId,
				projectId: project?.id as string,
				name: "Ping everything",
				playbook: "ping.yml",
				targets: { serverIds: [], all: true },
				become: false,
			})
			.returning();
		expect(template?.checkMode).toBe(true);
	});
});
