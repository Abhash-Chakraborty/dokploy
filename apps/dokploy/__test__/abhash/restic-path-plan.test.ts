import { dumpPlan } from "@dokploy/server/services/abhash/backups/restic";
import { describe, expect, it } from "vitest";

describe("dumpPlan for folders", () => {
	it("reads the folder through a read-only container, not as the SSH user", () => {
		const plan = dumpPlan("path", {
			appName: "adguard",
			path: "/opt/dokploy-adguard",
		});
		expect(plan.command).toBe(
			"docker run --rm -v '/opt/dokploy-adguard:/data:ro' alpine:3.20 tar -cf - -C /data .",
		);
		expect(plan.filename).toBe("-opt-dokploy-adguard.tar");
	});

	it("quotes a path with spaces", () => {
		const plan = dumpPlan("path", { appName: "x", path: "/srv/my data" });
		expect(plan.command).toContain("-v '/srv/my data:/data:ro'");
	});

	it("backs up /etc/dokploy for Dokploy itself", () => {
		expect(dumpPlan("dokploy", { appName: "dokploy" }).command).toContain(
			"-v '/etc/dokploy:/data:ro'",
		);
	});
});
