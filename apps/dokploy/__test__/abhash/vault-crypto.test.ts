import { randomBytes } from "node:crypto";
import {
	decryptSecretValue,
	encryptSecretValue,
	keyIdOf,
	openRecoveryKit,
	rewrapKey,
	sealRecoveryKit,
} from "@dokploy/server/services/abhash/vault/crypto";
import { describe, expect, it } from "vitest";

const key = randomBytes(32);

describe("vault crypto", () => {
	it("round-trips a value under the master key", () => {
		const sealed = encryptSecretValue(key, "hunter2", "secret1|1");
		expect(sealed.ciphertext).not.toContain("hunter2");
		expect(sealed.keyId).toBe(keyIdOf(key));
		expect(decryptSecretValue(key, sealed, "secret1|1")).toBe("hunter2");
	});

	it("refuses a ciphertext moved to another secret or version", () => {
		const sealed = encryptSecretValue(key, "hunter2", "secret1|1");
		expect(() => decryptSecretValue(key, sealed, "secret2|1")).toThrow();
		expect(() => decryptSecretValue(key, sealed, "secret1|2")).toThrow();
	});

	it("refuses a tampered ciphertext", () => {
		const sealed = encryptSecretValue(key, "hunter2", "s|1");
		const raw = Buffer.from(sealed.ciphertext, "base64");
		raw[raw.length - 1] = (raw.at(-1) ?? 0) ^ 0xff;
		expect(() =>
			decryptSecretValue(
				key,
				{ ...sealed, ciphertext: raw.toString("base64") },
				"s|1",
			),
		).toThrow();
	});

	it("refuses another master key", () => {
		const sealed = encryptSecretValue(key, "hunter2", "s|1");
		expect(() => decryptSecretValue(randomBytes(32), sealed, "s|1")).toThrow();
	});

	it("rewraps a data key without touching the value", () => {
		const next = randomBytes(32);
		const sealed = encryptSecretValue(key, "hunter2", "s|1");
		const rewrapped = {
			...sealed,
			wrappedKey: rewrapKey(key, next, sealed.wrappedKey, "s|1"),
		};
		expect(rewrapped.ciphertext).toBe(sealed.ciphertext);
		expect(decryptSecretValue(next, rewrapped, "s|1")).toBe("hunter2");
		expect(() => decryptSecretValue(key, rewrapped, "s|1")).toThrow();
	});

	it("seals and opens a recovery kit", () => {
		const kit = sealRecoveryKit("keyring", ["abc"], "correct horse battery");
		expect(kit.sealed).not.toContain("keyring");
		expect(kit.keyIds).toEqual(["abc"]);
		expect(openRecoveryKit(kit, "correct horse battery")).toBe("keyring");
		expect(() => openRecoveryKit(kit, "wrong passphrase")).toThrow(
			/passphrase/i,
		);
	});
});
