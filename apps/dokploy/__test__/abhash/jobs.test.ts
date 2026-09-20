import { connectionOptions } from "@dokploy/server/services/abhash/jobs/connection";
import { redactText } from "@dokploy/server/services/abhash/jobs/logs";
import {
	defineJob,
	getJobDefinition,
} from "@dokploy/server/services/abhash/jobs/registry";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

describe("job logs", () => {
	it("redacts every occurrence of a secret", () => {
		expect(redactText("token=abcd1234 and abcd1234", ["abcd1234"])).toBe(
			"token=•••• and ••••",
		);
	});

	it("ignores very short values that would shred the log", () => {
		expect(redactText("a b c", ["a"])).toBe("a b c");
	});
});

describe("redis connection", () => {
	const saved = { ...process.env };
	afterEach(() => {
		process.env = { ...saved };
	});

	it("parses REDIS_URL including credentials and db", () => {
		process.env.REDIS_URL = "redis://user:p%40ss@cache.internal:6380/2";
		expect(connectionOptions("producer")).toMatchObject({
			host: "cache.internal",
			port: 6380,
			username: "user",
			password: "p@ss",
			db: 2,
			enableOfflineQueue: false,
			maxRetriesPerRequest: null,
		});
	});

	it("keeps the offline queue for workers so they reconnect", () => {
		process.env.REDIS_URL = "redis://127.0.0.1:6379";
		expect(connectionOptions("worker")).toMatchObject({
			enableOfflineQueue: true,
		});
	});
});

describe("job registry", () => {
	it("registers definitions by type", () => {
		defineJob({
			type: "test.registry",
			queue: "abhash-infra",
			input: z.object({ n: z.number() }),
			title: (input) => `n=${input.n}`,
			run: async () => null,
		});
		const definition = getJobDefinition("test.registry");
		expect(definition?.title({ n: 3 })).toBe("n=3");
		expect(getJobDefinition("test.missing")).toBeUndefined();
	});
});
