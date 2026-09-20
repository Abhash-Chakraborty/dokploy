import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { abhashServerMesh, type MeshKind, server } from "../../../db/schema";
import { execPooled } from "../ssh/pool";
import { readMeshIp } from "./jobs";

export interface DetectedMesh {
	serverId: string;
	name: string;
	/** The address Dokploy currently connects to. */
	ipAddress: string;
	kind: MeshKind | null;
	meshIp: string | null;
	clientVersion: string | null;
	/** Dokploy already has a mesh row for this server. */
	tracked: boolean;
	/** The server is reachable on its mesh address already. */
	connectedOverMesh: boolean;
	error: string | null;
}

/**
 * Reads the mesh client on each server directly, rather than asking a provider
 * API. A fleet joined to NetBird or Tailscale by hand has no provider record
 * here, which is exactly the case this exists to find.
 */
const PROBE = [
	"if command -v netbird >/dev/null 2>&1; then",
	'  echo "kind=netbird";',
	'  echo "version=$(netbird version 2>/dev/null | head -n1)";',
	"  netbird status --json 2>/dev/null || netbird status 2>/dev/null;",
	"elif command -v tailscale >/dev/null 2>&1; then",
	'  echo "kind=headscale";',
	'  echo "version=$(tailscale version 2>/dev/null | head -n1)";',
	"  tailscale status --json 2>/dev/null;",
	"else",
	'  echo "kind=none";',
	"fi",
].join("\n");

/** Mesh clients hand out addresses in the CGNAT range reserved for them. */
export const isMeshAddress = (address: string) => {
	const octets = address.split(".").map(Number);
	if (octets.length !== 4 || octets.some((n) => !Number.isFinite(n))) {
		return false;
	}
	return octets[0] === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 0) <= 127;
};

const parseProbe = (stdout: string) => {
	const kindLine = stdout.match(/^kind=(\w+)$/m)?.[1] ?? "none";
	const version = stdout.match(/^version=(.*)$/m)?.[1]?.trim() || null;
	const body = stdout
		.split("\n")
		.filter((line) => !/^(kind|version)=/.test(line))
		.join("\n");
	return { kindLine, version, body };
};

export const detectMesh = async (
	organizationId: string,
): Promise<DetectedMesh[]> => {
	const servers = await db.query.server.findMany({
		where: eq(server.organizationId, organizationId),
		columns: { serverId: true, name: true, ipAddress: true },
	});
	const tracked = new Set(
		(
			await db
				.select({ serverId: abhashServerMesh.serverId })
				.from(abhashServerMesh)
		).map((row) => row.serverId),
	);

	return Promise.all(
		servers.map(async (row): Promise<DetectedMesh> => {
			const base = {
				serverId: row.serverId,
				name: row.name,
				ipAddress: row.ipAddress,
				tracked: tracked.has(row.serverId),
				connectedOverMesh: isMeshAddress(row.ipAddress),
			};
			try {
				const result = await execPooled(row.serverId, PROBE, {
					timeoutMs: 30_000,
				});
				const { kindLine, version, body } = parseProbe(result.stdout);
				if (kindLine === "none") {
					return {
						...base,
						kind: null,
						meshIp: null,
						clientVersion: null,
						error: null,
					};
				}
				const kind = kindLine as MeshKind;
				return {
					...base,
					kind,
					meshIp: readMeshIp(kind, body) ?? null,
					clientVersion: version,
					error: null,
				};
			} catch (error) {
				return {
					...base,
					kind: null,
					meshIp: null,
					clientVersion: null,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}),
	);
};
