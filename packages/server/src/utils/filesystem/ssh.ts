import * as ssh2 from "ssh2";

/**
 * OpenSSH refuses a key file with CRLF endings, surrounding whitespace or no
 * final newline, reporting "error in libcrypto". The ssh2 library accepts all
 * three, so a key pasted by hand can connect from Node and still fail inside a
 * container that shells out to ssh. Normalise wherever a key reaches disk.
 */
export const normalizePrivateKey = (key: string) =>
	`${key.replace(/\r\n?/g, "\n").trim()}\n`;

export const generateSSHKey = async (type: "rsa" | "ed25519" = "rsa") => {
	try {
		if (type === "rsa") {
			const keys = ssh2.utils.generateKeyPairSync("rsa", {
				bits: 4096,
				comment: "dokploy",
			});
			return {
				privateKey: keys.private,
				publicKey: keys.public,
			};
		}
		const keys = ssh2.utils.generateKeyPairSync("ed25519", {
			comment: "dokploy",
		});

		return {
			privateKey: keys.private,
			publicKey: keys.public,
		};
	} catch (error) {
		throw error;
	}
};
