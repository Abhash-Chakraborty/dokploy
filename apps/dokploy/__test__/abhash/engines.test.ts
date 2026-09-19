import {
	ENGINES,
	engineById,
} from "@dokploy/server/services/abhash/engines/catalog";
import { generatePassword } from "@dokploy/server/services/abhash/engines/service";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("engine catalog", () => {
	it.each(ENGINES.map((engine) => [engine.id, engine] as const))(
		"%s renders a valid compose stack",
		(_id, engine) => {
			const password = "SuperSecretValue123";
			const rendered = engine.render({
				name: "sample",
				version: engine.versions[0] as string,
				config: Object.fromEntries(
					engine.fields
						.filter((field) => field.default !== undefined)
						.map((field) => [field.name, field.default as string]),
				),
				password,
			});
			const parsed = parse(rendered.compose) as {
				services: Record<string, { image?: string; restart?: string }>;
			};
			expect(Object.keys(parsed.services).length).toBeGreaterThan(0);
			for (const service of Object.values(parsed.services)) {
				expect(service.image).toBeTruthy();
			}
			// The password belongs in the env file, never in the compose file.
			expect(rendered.compose).not.toContain(password);
			if (Object.keys(rendered.env).length > 0) {
				expect(Object.values(rendered.env).join("")).toContain(password);
			}
			expect(rendered.ports.length).toBeGreaterThan(0);
			expect(rendered.connection.length).toBeGreaterThan(0);
		},
	);

	it("never publishes a port to the host by default", () => {
		for (const engine of ENGINES) {
			const rendered = engine.render({
				name: "sample",
				version: engine.versions[0] as string,
				config: {},
				password: "x",
			});
			const parsed = parse(rendered.compose) as {
				services: Record<string, { ports?: unknown }>;
			};
			for (const service of Object.values(parsed.services)) {
				expect(service.ports).toBeUndefined();
			}
		}
	});

	it("looks an engine up by id", () => {
		expect(engineById("valkey")?.label).toBe("Valkey");
		expect(engineById("nope")).toBeUndefined();
	});
});

describe("generated passwords", () => {
	it("are long, random and safe in a shell or a URL", () => {
		const first = generatePassword();
		const second = generatePassword();
		expect(first).toHaveLength(32);
		expect(first).not.toBe(second);
		expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
	});
});
