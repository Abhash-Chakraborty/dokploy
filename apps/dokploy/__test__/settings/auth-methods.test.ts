import { authMethodsConfigSchema } from "@dokploy/server/db/schema";
import { describe, expect, it } from "vitest";

// GOAL §2.9: per-method login toggles must always leave at least one method
// enabled. This guards against locking everyone out of the instance.
describe("authMethodsConfigSchema", () => {
	it("accepts a config with all methods enabled", () => {
		const result = authMethodsConfigSchema.safeParse({
			emailPassword: true,
			github: true,
			google: true,
			passkey: true,
		});
		expect(result.success).toBe(true);
	});

	it("accepts a config with exactly one method enabled", () => {
		const result = authMethodsConfigSchema.safeParse({
			emailPassword: true,
			github: false,
			google: false,
			passkey: false,
		});
		expect(result.success).toBe(true);
	});

	it("rejects a config with every method disabled", () => {
		const result = authMethodsConfigSchema.safeParse({
			emailPassword: false,
			github: false,
			google: false,
			passkey: false,
		});
		expect(result.success).toBe(false);
	});

	it("rejects a config missing a method key", () => {
		const result = authMethodsConfigSchema.safeParse({
			emailPassword: true,
			github: true,
		});
		expect(result.success).toBe(false);
	});
});
