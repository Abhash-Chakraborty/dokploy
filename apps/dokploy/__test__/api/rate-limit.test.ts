import { beforeEach, describe, expect, it } from "vitest";
import { consume, resetRateLimits } from "../../server/api/rate-limit";

describe("mutation rate limiter", () => {
	beforeEach(() => {
		resetRateLimits();
	});

	it("allows up to the limit and then refuses", () => {
		const now = 1_000_000;
		for (let i = 0; i < 5; i++) {
			expect(consume("user:a:app.create", 5, 60, now).allowed).toBe(true);
		}
		const blocked = consume("user:a:app.create", 5, 60, now);
		expect(blocked.allowed).toBe(false);
		expect(blocked.retryAfterSeconds).toBe(60);
	});

	it("reports the remaining budget", () => {
		const now = 1_000_000;
		expect(consume("user:b:x", 3, 60, now).remaining).toBe(2);
		expect(consume("user:b:x", 3, 60, now).remaining).toBe(1);
		expect(consume("user:b:x", 3, 60, now).remaining).toBe(0);
	});

	it("keeps callers and paths in separate buckets", () => {
		const now = 1_000_000;
		expect(consume("user:a:one", 1, 60, now).allowed).toBe(true);
		expect(consume("user:a:one", 1, 60, now).allowed).toBe(false);
		// different path, same caller
		expect(consume("user:a:two", 1, 60, now).allowed).toBe(true);
		// same path, different caller
		expect(consume("user:b:one", 1, 60, now).allowed).toBe(true);
	});

	it("opens a fresh window once the old one expires", () => {
		const start = 1_000_000;
		expect(consume("user:c:x", 1, 60, start).allowed).toBe(true);
		expect(consume("user:c:x", 1, 60, start + 59_000).allowed).toBe(false);
		expect(consume("user:c:x", 1, 60, start + 60_001).allowed).toBe(true);
	});

	it("counts a burst inside one window against the same budget", () => {
		const start = 1_000_000;
		expect(consume("user:d:x", 2, 60, start).allowed).toBe(true);
		expect(consume("user:d:x", 2, 60, start + 100).allowed).toBe(true);
		expect(consume("user:d:x", 2, 60, start + 200).allowed).toBe(false);
	});
});
