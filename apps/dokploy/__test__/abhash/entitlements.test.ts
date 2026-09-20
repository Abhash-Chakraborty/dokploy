import { resolveOrganizationDefaultRole } from "@dokploy/server/services/abhash/entitlements";
import { getAccessibleServerIds } from "@dokploy/server/services/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
	query: {
		server: { findMany: vi.fn() },
		member: { findFirst: vi.fn() },
		organization: { findFirst: vi.fn() },
		organizationRole: { findFirst: vi.fn() },
	},
}));

vi.mock("@dokploy/server/db", () => ({ db: mockDb }));

const session = { userId: "u1", activeOrganizationId: "org-1" };

describe("getAccessibleServerIds (fork: no licence tier)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.query.server.findMany.mockResolvedValue([
			{ serverId: "s1" },
			{ serverId: "s2" },
			{ serverId: "s3" },
		]);
	});

	it("scopes a member to the servers assigned to them", async () => {
		mockDb.query.member.findFirst.mockResolvedValue({
			role: "member",
			accessedServers: ["s2"],
		});
		expect(await getAccessibleServerIds(session)).toEqual(new Set(["s2"]));
	});

	it("gives a member with no assignments no servers", async () => {
		mockDb.query.member.findFirst.mockResolvedValue({
			role: "member",
			accessedServers: [],
		});
		expect(await getAccessibleServerIds(session)).toEqual(new Set());
	});

	it.each(["owner", "admin"])("gives an %s every server", async (role) => {
		mockDb.query.member.findFirst.mockResolvedValue({
			role,
			accessedServers: [],
		});
		expect(await getAccessibleServerIds(session)).toEqual(
			new Set(["s1", "s2", "s3"]),
		);
	});
});

describe("resolveOrganizationDefaultRole", () => {
	beforeEach(() => vi.clearAllMocks());

	it.each([
		[null, "member"],
		["owner", "member"],
		["admin", "admin"],
		["member", "member"],
	])("default %s resolves to %s", async (defaultRole, expected) => {
		mockDb.query.organization.findFirst.mockResolvedValue({ defaultRole });
		expect(await resolveOrganizationDefaultRole("org-1")).toBe(expected);
	});

	it("uses an existing custom role", async () => {
		mockDb.query.organization.findFirst.mockResolvedValue({
			defaultRole: "release-manager",
		});
		mockDb.query.organizationRole.findFirst.mockResolvedValue({ id: "r1" });
		expect(await resolveOrganizationDefaultRole("org-1")).toBe(
			"release-manager",
		);
	});

	it("falls back to member when the custom role no longer exists", async () => {
		mockDb.query.organization.findFirst.mockResolvedValue({
			defaultRole: "deleted-role",
		});
		mockDb.query.organizationRole.findFirst.mockResolvedValue(undefined);
		expect(await resolveOrganizationDefaultRole("org-1")).toBe("member");
	});
});
