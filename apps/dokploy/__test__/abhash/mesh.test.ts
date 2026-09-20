import { createServer, type Server } from "node:http";
import { DEFAULT_MESH_SETTINGS } from "@dokploy/server/db/schema";
import { isMeshAddress } from "@dokploy/server/services/abhash/mesh/detect";
import {
	headscale,
	headscalePolicySnippet,
} from "@dokploy/server/services/abhash/mesh/headscale";
import { readMeshIp } from "@dokploy/server/services/abhash/mesh/jobs";
import { netbird } from "@dokploy/server/services/abhash/mesh/netbird";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Call = { method: string; path: string; body: unknown; auth?: string };

const calls: Call[] = [];
let routes: Record<string, unknown> = {};
let server: Server;
let baseUrl = "";

beforeAll(async () => {
	server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			const path = req.url ?? "";
			calls.push({
				method: req.method ?? "GET",
				path,
				body: raw ? JSON.parse(raw) : null,
				auth: req.headers.authorization,
			});
			const key = `${req.method} ${path}`;
			const value = routes[key] ?? routes[path];
			res.writeHead(value === undefined ? 404 : 200, {
				"content-type": "application/json",
			});
			res.end(JSON.stringify(value ?? { message: "not stubbed" }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => server.close());

const context = (overrides: Partial<typeof DEFAULT_MESH_SETTINGS> = {}) => ({
	baseUrl,
	token: "test-token",
	settings: { ...DEFAULT_MESH_SETTINGS, ...overrides },
});

describe("netbird", () => {
	it("authenticates with a Token header and lists peers", async () => {
		calls.length = 0;
		routes = {
			"/api/peers": [
				{
					id: "p1",
					name: "dokploy-web",
					ip: "100.64.0.5",
					dns_label: "dokploy-web.netbird.cloud",
					connected: true,
					version: "0.76.3",
				},
			],
		};
		const peers = await netbird(context()).listPeers();
		expect(peers).toEqual([
			{
				id: "p1",
				name: "dokploy-web",
				ip: "100.64.0.5",
				hostname: "dokploy-web.netbird.cloud",
				connected: true,
				lastSeen: undefined,
				version: "0.76.3",
				os: undefined,
			},
		]);
		expect(calls[0]?.auth).toBe("Token test-token");
	});

	it("creates a one-off key that expires and auto-joins the servers group", async () => {
		calls.length = 0;
		routes = {
			"/api/groups": [{ id: "g-servers", name: "dokploy-servers" }],
			"POST /api/setup-keys": { key: "SETUP-KEY", expires: "2026-01-01" },
		};
		const key = await netbird(context()).createEnrollmentKey("dokploy-web");
		expect(key.key).toBe("SETUP-KEY");
		const create = calls.find((call) => call.path === "/api/setup-keys");
		expect(create?.body).toMatchObject({
			type: "one-off",
			usage_limit: 1,
			expires_in: 3600,
			auto_groups: ["g-servers"],
		});
	});

	it("plans only the objects it owns and leaves the rest alone", async () => {
		calls.length = 0;
		routes = {
			"/api/groups": [
				{ id: "g-servers", name: "dokploy-servers" },
				{ id: "g-other", name: "my-own-group" },
			],
			"/api/policies": [
				{ id: "pol-mine", name: "my-own-policy", enabled: true },
				{ id: "pol-old", name: "dokploy-swarm", enabled: true },
			],
			"POST /api/groups": { id: "g-control", name: "dokploy-control" },
			"POST /api/policies": { id: "pol-new" },
			"DELETE /api/policies/pol-old": {},
		};
		const plan = await netbird(context()).ensurePolicy(false);
		expect(plan.create).toContain("group dokploy-control");
		expect(plan.keep).toContain("group dokploy-servers");
		expect(plan.create).toContain("policy dokploy-control-to-servers");
		// Swarm is off, so the leftover dokploy policy goes; the user's stays.
		expect(plan.remove).toEqual(["policy dokploy-swarm"]);
		expect(calls.some((call) => call.path.includes("pol-mine"))).toBe(false);
	});

	it("joins with DNS management off and the server's own SSH disabled", () => {
		const command = netbird(context()).joinCommand("KEY", "dokploy-web");
		expect(command).toContain("--disable-dns");
		expect(command).toContain("--allow-server-ssh=false");
		expect(command).toContain("--setup-key 'KEY'");
		expect(
			netbird(context({ manageDns: true })).joinCommand("K", "h"),
		).not.toContain("--disable-dns");
	});

	it("reports an API error instead of pretending it worked", async () => {
		routes = {};
		await expect(netbird(context()).listPeers()).rejects.toThrow(/failed: 404/);
	});
});

describe("headscale", () => {
	it("uses a Bearer token and a tagged, expiring pre-auth key", async () => {
		calls.length = 0;
		routes = { "POST /api/v1/preauthkey": { preAuthKey: { key: "HS-KEY" } } };
		const key = await headscale(context()).createEnrollmentKey("dokploy-web");
		expect(key.key).toBe("HS-KEY");
		expect(calls[0]?.auth).toBe("Bearer test-token");
		expect(calls[0]?.body).toMatchObject({
			reusable: false,
			aclTags: ["tag:dokploy-server"],
		});
	});

	it("never writes the policy, it shows the snippet", async () => {
		const plan = await headscale(context()).ensurePolicy(false);
		expect(plan.create).toEqual([]);
		expect(headscalePolicySnippet("dokploy", 22)).toContain(
			"tag:dokploy-server",
		);
	});
});

describe("reading the mesh address the client got", () => {
	it("reads NetBird's status", () => {
		expect(readMeshIp("netbird", '{"netbirdIp":"100.97.1.5/16"}')).toBe(
			"100.97.1.5",
		);
	});

	it("reads Tailscale's status", () => {
		expect(
			readMeshIp("headscale", '{"Self":{"TailscaleIPs":["100.64.0.3"]}}'),
		).toBe("100.64.0.3");
	});

	it("falls back to the first address in plain output", () => {
		expect(readMeshIp("netbird", "NetBird IP: 100.97.9.9/16")).toBe(
			"100.97.9.9",
		);
	});
});

describe("isMeshAddress", () => {
	it("accepts the CGNAT range mesh clients hand out", () => {
		for (const address of ["100.64.0.1", "100.97.140.122", "100.127.255.254"]) {
			expect(isMeshAddress(address)).toBe(true);
		}
	});

	it("rejects public and private addresses outside that range", () => {
		for (const address of [
			"100.63.255.255",
			"100.128.0.1",
			"10.0.0.1",
			"192.168.1.10",
			"8.8.8.8",
		]) {
			expect(isMeshAddress(address)).toBe(false);
		}
	});

	it("rejects anything that is not four numeric octets", () => {
		for (const address of ["", "100.97.140", "example.com", "::1"]) {
			expect(isMeshAddress(address)).toBe(false);
		}
	});
});
