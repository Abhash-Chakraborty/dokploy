import {
	signPayload,
	verifySignature,
} from "@dokploy/server/services/abhash/webhooks";
import { describe, expect, it } from "vitest";

describe("webhook signatures", () => {
	const secret = "a-long-shared-secret";
	const body = JSON.stringify({ event: "job.failed", data: { jobId: "j1" } });

	it("signs with HMAC-SHA256 and a prefix a receiver can recognise", () => {
		const signature = signPayload(secret, body);
		expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
	});

	it("accepts its own signature", () => {
		expect(verifySignature(secret, body, signPayload(secret, body))).toBe(true);
	});

	it("rejects a changed body, a changed secret and a truncated signature", () => {
		const signature = signPayload(secret, body);
		expect(verifySignature(secret, `${body} `, signature)).toBe(false);
		expect(verifySignature("other-secret", body, signature)).toBe(false);
		expect(verifySignature(secret, body, signature.slice(0, -2))).toBe(false);
	});
});
