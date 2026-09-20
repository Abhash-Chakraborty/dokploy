import { customType } from "drizzle-orm/pg-core";
import { decryptValue, encryptValue, isEncrypted } from "../../lib/encryption";

// Whether new writes are encrypted. Set at startup and when the owner
// toggles it, and shared across route bundles like the other fork caches.
// Reads always accept both, so turning it off (and running the backfill in
// reverse) restores plain values for an older image.
const shared = globalThis as unknown as {
	__abhashEncryptCredentials?: boolean;
};

export const setCredentialEncryption = (enabled: boolean) => {
	shared.__abhashEncryptCredentials = enabled;
};

export const credentialEncryptionOn = () =>
	shared.__abhashEncryptCredentials === true;

/**
 * A credential column that upstream stores as plain text. Same on-disk
 * format as upstream's `encryptedText`, so the previous image can still read
 * it after a rollback.
 */
export const credentialText = customType<{
	data: string;
	driverData: string;
}>({
	dataType() {
		return "text";
	},
	toDriver(value) {
		return credentialEncryptionOn() ? encryptValue(value) : value;
	},
	fromDriver(value) {
		try {
			return decryptValue(value);
		} catch {
			console.error(
				"Failed to decrypt a credential; returning the stored value. ENCRYPTION_KEY or BETTER_AUTH_SECRET probably changed.",
			);
			return value;
		}
	},
});

/** The same, for a jsonb column whose contents are credentials. */
export const credentialJson = <T>() =>
	customType<{ data: T; driverData: unknown }>({
		dataType() {
			return "jsonb";
		},
		toDriver(value) {
			return credentialEncryptionOn()
				? encryptValue(JSON.stringify(value))
				: (value as unknown);
		},
		fromDriver(value) {
			if (typeof value !== "string") return value as T;
			try {
				return JSON.parse(
					isEncrypted(value) ? decryptValue(value) : value,
				) as T;
			} catch {
				return value as unknown as T;
			}
		},
	});
