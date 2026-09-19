import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
	scryptSync,
} from "node:crypto";

const IV = 12;
const TAG = 16;

export const keyIdOf = (key: Buffer) =>
	createHash("sha256").update(key).digest("hex").slice(0, 16);

const seal = (key: Buffer, plaintext: Buffer, aad: string) => {
	const iv = randomBytes(IV);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(Buffer.from(aad));
	const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
};

const open = (key: Buffer, sealed: string, aad: string) => {
	const raw = Buffer.from(sealed, "base64");
	const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV));
	decipher.setAAD(Buffer.from(aad));
	decipher.setAuthTag(raw.subarray(IV, IV + TAG));
	return Buffer.concat([
		decipher.update(raw.subarray(IV + TAG)),
		decipher.final(),
	]);
};

/**
 * Envelope encryption: a fresh data key per secret version encrypts the
 * value, and the master key only ever wraps data keys. The AAD binds both
 * to the secret and version, so a ciphertext copied onto another row fails
 * authentication instead of decrypting as the wrong secret.
 */
export const encryptSecretValue = (
	masterKey: Buffer,
	value: string,
	binding: string,
) => {
	const dataKey = randomBytes(32);
	try {
		return {
			ciphertext: seal(dataKey, Buffer.from(value, "utf8"), `value|${binding}`),
			wrappedKey: seal(masterKey, dataKey, `key|${binding}`),
			keyId: keyIdOf(masterKey),
		};
	} finally {
		dataKey.fill(0);
	}
};

export const decryptSecretValue = (
	masterKey: Buffer,
	sealed: { ciphertext: string; wrappedKey: string },
	binding: string,
) => {
	const dataKey = open(masterKey, sealed.wrappedKey, `key|${binding}`);
	try {
		return open(dataKey, sealed.ciphertext, `value|${binding}`).toString(
			"utf8",
		);
	} finally {
		dataKey.fill(0);
	}
};

export const rewrapKey = (
	from: Buffer,
	to: Buffer,
	wrappedKey: string,
	binding: string,
) => {
	const dataKey = open(from, wrappedKey, `key|${binding}`);
	try {
		return seal(to, dataKey, `key|${binding}`);
	} finally {
		dataKey.fill(0);
	}
};

const KIT_SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export type RecoveryKit = {
	format: "dokploy-vault-recovery";
	version: 1;
	keyIds: string[];
	createdAt: string;
	salt: string;
	sealed: string;
};

/** The keyring sealed under a passphrase, for disaster recovery. */
export const sealRecoveryKit = (
	payload: string,
	keyIds: string[],
	passphrase: string,
): RecoveryKit => {
	const salt = randomBytes(16);
	const key = scryptSync(passphrase, salt, 32, KIT_SCRYPT);
	return {
		format: "dokploy-vault-recovery",
		version: 1,
		keyIds,
		createdAt: new Date().toISOString(),
		salt: salt.toString("base64"),
		sealed: seal(key, Buffer.from(payload, "utf8"), "dokploy-vault-recovery"),
	};
};

export const openRecoveryKit = (kit: RecoveryKit, passphrase: string) => {
	const key = scryptSync(
		passphrase,
		Buffer.from(kit.salt, "base64"),
		32,
		KIT_SCRYPT,
	);
	try {
		return open(key, kit.sealed, "dokploy-vault-recovery").toString("utf8");
	} catch {
		throw new Error("Wrong passphrase or damaged recovery kit");
	}
};
