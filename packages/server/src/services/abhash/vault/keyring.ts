import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { paths } from "../../../constants";
import {
	keyIdOf,
	openRecoveryKit,
	type RecoveryKit,
	sealRecoveryKit,
} from "./crypto";

type KeyringFile = {
	version: 1;
	current: string;
	keys: Record<string, string>;
};

export class VaultLockedError extends Error {
	constructor() {
		super(
			"The vault master key is missing. Restore it from your recovery kit in Settings -> Vault.",
		);
	}
}

// Next.js route bundles each load this module; share one cache per process.
const shared = globalThis as unknown as {
	__abhashKeyring?: { mtimeMs: number; file: KeyringFile } | null;
};

export const keyringPath = () =>
	path.join(paths().BASE_PATH, "abhash", "vault-keyring.json");

const readKeyring = (): KeyringFile | null => {
	const file = keyringPath();
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		shared.__abhashKeyring = null;
		return null;
	}
	const cached = shared.__abhashKeyring;
	if (cached && cached.mtimeMs === stat.mtimeMs) return cached.file;
	const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as KeyringFile;
	if (parsed.version !== 1 || !parsed.keys[parsed.current]) {
		throw new Error(`${file} is not a valid vault keyring`);
	}
	shared.__abhashKeyring = { mtimeMs: stat.mtimeMs, file: parsed };
	return parsed;
};

const writeKeyring = (keyring: KeyringFile) => {
	const file = keyringPath();
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	// Written to a temp file and renamed, so a crash never leaves half a key.
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(keyring), { mode: 0o400 });
	fs.renameSync(tmp, file);
	shared.__abhashKeyring = null;
};

export const hasKeyring = () => readKeyring() !== null;

export const currentKey = () => {
	const keyring = readKeyring();
	if (!keyring) throw new VaultLockedError();
	return {
		id: keyring.current,
		key: Buffer.from(keyring.keys[keyring.current] as string, "base64"),
	};
};

export const keyById = (id: string) => {
	const keyring = readKeyring();
	if (!keyring) throw new VaultLockedError();
	const encoded = keyring.keys[id];
	if (!encoded) {
		throw new Error(
			`Master key ${id} is not in the keyring; restore the recovery kit that holds it`,
		);
	}
	return Buffer.from(encoded, "base64");
};

export const keyringIds = () => Object.keys(readKeyring()?.keys ?? {});

/** Creates the keyring once; never replaces an existing one. */
export const createKeyring = () => {
	if (readKeyring()) return currentKey().id;
	const key = randomBytes(32);
	const id = keyIdOf(key);
	writeKeyring({
		version: 1,
		current: id,
		keys: { [id]: key.toString("base64") },
	});
	return id;
};

/** Adds a new current key; old keys stay until every data key is rewrapped. */
export const addRotationKey = () => {
	const keyring = readKeyring();
	if (!keyring) throw new VaultLockedError();
	const key = randomBytes(32);
	const id = keyIdOf(key);
	writeKeyring({
		version: 1,
		current: id,
		keys: { ...keyring.keys, [id]: key.toString("base64") },
	});
	return id;
};

export const retireKeys = (keep: string[]) => {
	const keyring = readKeyring();
	if (!keyring) throw new VaultLockedError();
	const keys = Object.fromEntries(
		Object.entries(keyring.keys).filter(
			([id]) => id === keyring.current || keep.includes(id),
		),
	);
	writeKeyring({ ...keyring, keys });
};

export const exportRecoveryKit = (passphrase: string): RecoveryKit => {
	const keyring = readKeyring();
	if (!keyring) throw new VaultLockedError();
	return sealRecoveryKit(
		JSON.stringify(keyring),
		Object.keys(keyring.keys),
		passphrase,
	);
};

/**
 * Restores keys from a kit, merging with any keys already present so a
 * restore can never drop a key that live data still needs.
 */
export const importRecoveryKit = (kit: RecoveryKit, passphrase: string) => {
	if (kit?.format !== "dokploy-vault-recovery" || kit.version !== 1) {
		throw new Error("This is not a Dokploy vault recovery kit");
	}
	const restored = JSON.parse(openRecoveryKit(kit, passphrase)) as KeyringFile;
	for (const [id, encoded] of Object.entries(restored.keys)) {
		if (keyIdOf(Buffer.from(encoded, "base64")) !== id) {
			throw new Error("The recovery kit is damaged");
		}
	}
	const existing = readKeyring();
	writeKeyring({
		version: 1,
		current: existing?.current ?? restored.current,
		keys: { ...restored.keys, ...(existing?.keys ?? {}) },
	});
	return Object.keys(restored.keys);
};
