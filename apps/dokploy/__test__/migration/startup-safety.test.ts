import { afterEach, describe, expect, it, vi } from "vitest";
import { runMigration } from "../../migration-runner";
import packageJson from "../../package.json";

const originalExitCode = process.exitCode;

describe("migration startup safety", () => {
	afterEach(() => {
		process.exitCode = originalExitCode;
		vi.restoreAllMocks();
	});

	it("completes normally and closes PostgreSQL exactly once", async () => {
		const close = vi.fn(async () => {});
		const error = vi.fn();
		const log = vi.fn();
		const migrate = vi.fn(async () => {});

		await expect(
			runMigration({ close, error, log, migrate }),
		).resolves.toBeUndefined();

		expect(migrate).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledWith("Migration complete");
		expect(error).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
		expect(process.exitCode).toBe(originalExitCode);
	});

	it("fails the process, reports the error, and still closes PostgreSQL", async () => {
		const migrationError = new Error("migration rejected");
		const close = vi.fn(async () => {});
		const error = vi.fn();
		const log = vi.fn();
		const migrate = vi.fn(async () => {
			throw migrationError;
		});

		await expect(runMigration({ close, error, log, migrate })).rejects.toBe(
			migrationError,
		);

		expect(error).toHaveBeenCalledWith("Migration failed", migrationError);
		expect(log).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
		expect(process.exitCode).toBe(1);
	});

	it("gates the main server behind the migration process", () => {
		expect(packageJson.scripts.start).toBe(
			"node -r dotenv/config dist/migration.mjs && node -r dotenv/config dist/server.mjs",
		);
		expect(packageJson.version).toBe("v0.29.12");
	});
});
