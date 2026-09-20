import fs from "node:fs";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { stringify } from "yaml";
import { IS_CLOUD, paths } from "../../constants";
import { db } from "../../db";
import { abhashForwardAuth, server } from "../../db/schema";
import {
	execAsyncRemote,
	writeFileRemote,
} from "../../utils/process/execAsync";

export const FORWARD_AUTH_FILE = "abhash-forward-auth.yml";

export const AUTHENTIK_RESPONSE_HEADERS = [
	"X-authentik-username",
	"X-authentik-groups",
	"X-authentik-entitlements",
	"X-authentik-email",
	"X-authentik-name",
	"X-authentik-uid",
	"X-authentik-jwt",
	"X-authentik-meta-jwks",
	"X-authentik-meta-outpost",
	"X-authentik-meta-provider",
	"X-authentik-meta-app",
	"X-authentik-meta-version",
];

type Gate = typeof abhashForwardAuth.$inferSelect;

export const middlewareName = (slug: string) => `abhash-fa-${slug}`;
/** The value a domain lists in its middlewares to be protected by the gate. */
export const middlewareRef = (slug: string) => `${middlewareName(slug)}@file`;

/** Authentik's embedded outpost endpoint for Traefik forward auth. */
export const authentikAddress = (baseUrl: string) =>
	`${baseUrl.trim().replace(/\/+$/, "")}/outpost.goauthentik.io/auth/traefik`;

/** The Traefik dynamic config holding every gate of the instance. */
export const renderForwardAuthConfig = (gates: Gate[]) => ({
	http: {
		middlewares: Object.fromEntries(
			gates.map((g) => [
				middlewareName(g.slug),
				{
					forwardAuth: {
						address: g.address,
						trustForwardHeader: g.trustForwardHeader,
						// Traefik otherwise buffers auth responses of any size.
						maxResponseBodySize: 1_048_576,
						...(g.authResponseHeaders.length
							? { authResponseHeaders: g.authResponseHeaders }
							: {}),
					},
				},
			]),
		),
	},
});

/** Domains of the organization that use a gate, for display and delete guards. */
export const domainsUsing = async (organizationId: string, slug: string) => {
	const rows = await db.execute<{ host: string }>(sql`
		SELECT d.host FROM domain d
		LEFT JOIN application a ON a."applicationId" = d."applicationId"
		LEFT JOIN compose c ON c."composeId" = d."composeId"
		JOIN environment e ON e."environmentId" = COALESCE(a."environmentId", c."environmentId")
		JOIN project p ON p."projectId" = e."projectId"
		WHERE p."organizationId" = ${organizationId}
			AND ${middlewareRef(slug)} = ANY(d.middlewares)`);
	return rows.map((r) => r.host);
};

export type SyncResult = { target: string; ok: boolean; error?: string };

/**
 * Writes the gates to the local Traefik and to every active remote server.
 * All gates of the instance go into one file per server, since a domain on
 * any server may reference any gate; with no gates the file is removed.
 */
export const syncForwardAuth = async (): Promise<SyncResult[]> => {
	const gates = await db.query.abhashForwardAuth.findMany();
	const yaml = stringify(renderForwardAuthConfig(gates));
	const results: SyncResult[] = [];

	if (!IS_CLOUD) {
		try {
			const { DYNAMIC_TRAEFIK_PATH } = paths();
			const file = path.join(DYNAMIC_TRAEFIK_PATH, FORWARD_AUTH_FILE);
			if (gates.length) {
				fs.mkdirSync(DYNAMIC_TRAEFIK_PATH, { recursive: true });
				fs.writeFileSync(file, yaml, "utf8");
			} else {
				fs.rmSync(file, { force: true });
			}
			results.push({ target: "Dokploy server", ok: true });
		} catch (error) {
			results.push({
				target: "Dokploy server",
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const remotes = await db.query.server.findMany({
		where: and(eq(server.serverStatus, "active"), isNotNull(server.sshKeyId)),
		columns: { serverId: true, name: true },
	});
	for (const remote of remotes) {
		try {
			const file = path.join(
				paths(true).DYNAMIC_TRAEFIK_PATH,
				FORWARD_AUTH_FILE,
			);
			if (gates.length) await writeFileRemote(remote.serverId, file, yaml);
			else await execAsyncRemote(remote.serverId, `rm -f '${file}'`);
			results.push({ target: remote.name, ok: true });
		} catch (error) {
			results.push({
				target: remote.name,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return results;
};

export type GateInput = {
	name: string;
	slug: string;
	kind: "authentik" | "generic";
	baseUrl?: string;
	address?: string;
	trustForwardHeader: boolean;
	authResponseHeaders?: string[];
};

const values = (input: GateInput) => {
	const address =
		input.kind === "authentik" && input.baseUrl
			? authentikAddress(input.baseUrl)
			: input.address;
	if (!address) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				input.kind === "authentik"
					? "Enter the Authentik URL"
					: "Enter the forward-auth address",
		});
	}
	try {
		const url = new URL(address);
		if (url.protocol !== "http:" && url.protocol !== "https:")
			throw new Error();
	} catch {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "The address must be an http(s) URL",
		});
	}
	return {
		name: input.name,
		kind: input.kind,
		baseUrl: input.kind === "authentik" ? input.baseUrl : null,
		address,
		trustForwardHeader: input.trustForwardHeader,
		authResponseHeaders:
			input.authResponseHeaders ??
			(input.kind === "authentik" ? AUTHENTIK_RESPONSE_HEADERS : []),
	};
};

export const createGate = async (organizationId: string, input: GateInput) => {
	const existing = await db.query.abhashForwardAuth.findFirst({
		where: eq(abhashForwardAuth.slug, input.slug),
	});
	if (existing) {
		throw new TRPCError({
			code: "CONFLICT",
			message: `"${input.slug}" is taken`,
		});
	}
	await db
		.insert(abhashForwardAuth)
		.values({ organizationId, slug: input.slug, ...values(input) });
	return syncForwardAuth();
};

const findGate = async (organizationId: string, id: string) => {
	const gate = await db.query.abhashForwardAuth.findFirst({
		where: and(
			eq(abhashForwardAuth.id, id),
			eq(abhashForwardAuth.organizationId, organizationId),
		),
	});
	if (!gate)
		throw new TRPCError({ code: "NOT_FOUND", message: "Gate not found" });
	return gate;
};

export const updateGate = async (
	organizationId: string,
	id: string,
	input: Omit<GateInput, "slug">,
) => {
	const gate = await findGate(organizationId, id);
	await db
		.update(abhashForwardAuth)
		.set(values({ ...input, slug: gate.slug }))
		.where(eq(abhashForwardAuth.id, gate.id));
	return syncForwardAuth();
};

/** Refused while a domain uses the gate: Traefik 404s a route whose middleware is missing. */
export const deleteGate = async (organizationId: string, id: string) => {
	const gate = await findGate(organizationId, id);
	const hosts = await domainsUsing(organizationId, gate.slug);
	if (hosts.length) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Remove protection from ${hosts.join(", ")} first`,
		});
	}
	await db.delete(abhashForwardAuth).where(eq(abhashForwardAuth.id, gate.id));
	return syncForwardAuth();
};

export const listGates = async (organizationId: string) => {
	const gates = await db.query.abhashForwardAuth.findMany({
		where: eq(abhashForwardAuth.organizationId, organizationId),
		orderBy: (g, { asc }) => [asc(g.name)],
	});
	return Promise.all(
		gates.map(async (g) => ({
			...g,
			middleware: middlewareRef(g.slug),
			domains: await domainsUsing(organizationId, g.slug),
		})),
	);
};
