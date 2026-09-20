import { loadCredentialEncryption } from "./credentials";

export * from "./credentials";
export * from "./crypto";
export * from "./keyring";
export * from "./secrets";

/** Called once at startup, before anything reads or writes a credential. */
export const initAbhashVault = async () => {
	await loadCredentialEncryption();
};
