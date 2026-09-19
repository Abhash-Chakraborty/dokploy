import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../../db";
import { scimProvider } from "../../../db/schema";

/** Same digest as the SCIM plugin's "hashed" token storage. */
export const hashScimToken = (token: string) =>
	createHash("sha256").update(token).digest("base64url");

/** Bearer tokens are base64url("<secret>:<providerId>:<organizationId>"). */
const encodeBearer = (
	secret: string,
	providerId: string,
	organizationId: string,
) =>
	Buffer.from(`${secret}:${providerId}:${organizationId}`).toString(
		"base64url",
	);

export const createScimConnection = async (
	organizationId: string,
	providerId: string,
) => {
	const secret = randomBytes(32).toString("base64url");
	await db
		.insert(scimProvider)
		.values({
			providerId,
			organizationId,
			scimToken: hashScimToken(secret),
		})
		.onConflictDoUpdate({
			target: scimProvider.providerId,
			set: { scimToken: hashScimToken(secret), organizationId },
		});
	return encodeBearer(secret, providerId, organizationId);
};

export const listScimConnections = (organizationId: string) =>
	db.query.scimProvider.findMany({
		where: eq(scimProvider.organizationId, organizationId),
		columns: { providerId: true, organizationId: true },
	});

export const revokeScimConnection = (
	organizationId: string,
	providerId: string,
) =>
	db
		.delete(scimProvider)
		.where(
			and(
				eq(scimProvider.organizationId, organizationId),
				eq(scimProvider.providerId, providerId),
			),
		);

/**
 * Verifies an `Authorization: Bearer` SCIM token against scim_provider, the
 * same way the SCIM plugin does, for the fork's own SCIM endpoints.
 */
export const verifyScimBearer = async (
	authorization: string | null | undefined,
) => {
	const bearer = authorization?.replace(/^Bearer\s+/i, "");
	if (!bearer) return null;
	const [secret, providerId, ...rest] = Buffer.from(bearer, "base64url")
		.toString("utf8")
		.split(":");
	const organizationId = rest.join(":");
	if (!secret || !providerId) return null;
	const row = await db.query.scimProvider.findFirst({
		where: and(
			eq(scimProvider.providerId, providerId),
			...(organizationId
				? [eq(scimProvider.organizationId, organizationId)]
				: []),
		),
	});
	if (!row?.organizationId) return null;
	const expected = Buffer.from(row.scimToken);
	const actual = Buffer.from(hashScimToken(secret));
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		return null;
	}
	return { providerId: row.providerId, organizationId: row.organizationId };
};
