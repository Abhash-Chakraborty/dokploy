import { matchesPattern } from "@dokploy/server/services/abhash/agents/policy";
import {
	MASK,
	maskEnvText,
	redactForActor,
} from "@dokploy/server/services/abhash/agents/redact";
import { describe, expect, it } from "vitest";

const agent = { type: "agent" as const, id: "a1", keyId: "k1" };
const person = { type: "user" as const, id: "u1" };

describe("agent redaction", () => {
	it("keeps variable names but removes their values", () => {
		expect(maskEnvText("API_KEY=live-abc\n# note\nEMPTY=")).toBe(
			`API_KEY=${MASK}\n# note\nEMPTY=${MASK}`,
		);
	});

	it("keeps vault references visible, since they are not values", () => {
		expect(maskEnvText("API_KEY=${{secret.API_KEY}}")).toBe(
			"API_KEY=${{secret.API_KEY}}",
		);
	});

	it("masks credential fields anywhere in the response", () => {
		const application = {
			name: "web",
			env: "TOKEN=abc",
			password: "registry-pass",
			registry: { password: "nested", url: "ghcr.io" },
			domains: [{ host: "x.test" }],
		};
		const masked = redactForActor(application, agent);
		expect(masked).toMatchObject({
			name: "web",
			env: `TOKEN=${MASK}`,
			password: MASK,
			registry: { password: MASK, url: "ghcr.io" },
			domains: [{ host: "x.test" }],
		});
		expect(JSON.stringify(masked)).not.toContain("registry-pass");
		expect(JSON.stringify(masked)).not.toContain("abc");
	});

	it("leaves a person's response untouched", () => {
		const data = { env: "TOKEN=abc", password: "p" };
		expect(redactForActor(data, person)).toEqual(data);
	});

	it("survives dates and nulls", () => {
		const createdAt = new Date();
		expect(
			redactForActor({ createdAt, password: null, token: "" }, agent),
		).toEqual({ createdAt, password: null, token: "" });
	});
});

describe("key policy patterns", () => {
	it("matches a prefix wildcard and exact names only", () => {
		expect(matchesPattern("project.*", "project.all")).toBe(true);
		expect(matchesPattern("project.*", "application.one")).toBe(false);
		expect(matchesPattern("project.all", "project.all")).toBe(true);
		expect(matchesPattern("project.all", "project.allDeep")).toBe(false);
	});
});

describe("fields that hold a reference, or the secret itself", () => {
	it("shows a reference and masks a literal", () => {
		const out = redactForActor(
			{
				webhooks: [
					{ name: "a", secretRef: "${{secret.HOOK_KEY}}" },
					{ name: "b", secretRef: "hunter2-hunter2" },
				],
				repository: { passwordRef: "plain-password", tokenRef: "" },
			},
			agent,
		);
		expect(out.webhooks[0]?.secretRef).toBe("${{secret.HOOK_KEY}}");
		expect(out.webhooks[1]?.secretRef).toBe(MASK);
		expect(out.repository.passwordRef).toBe(MASK);
		expect(out.repository.tokenRef).toBe("");
	});

	it("does not take a reference with something stuck to it for one", () => {
		const out = redactForActor(
			{ secretRef: "${{secret.A}}-and-a-literal-tail" },
			agent,
		);
		expect(out.secretRef).toBe(MASK);
	});
});
