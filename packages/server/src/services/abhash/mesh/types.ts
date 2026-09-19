import type { MeshSettings } from "../../../db/schema";

export type MeshPeer = {
	id: string;
	name: string;
	ip: string;
	hostname?: string;
	connected: boolean;
	lastSeen?: string;
	version?: string;
	os?: string;
};

export type EnrollmentKey = {
	key: string;
	expiresAt?: string;
};

export type PolicyPlan = {
	/** What Dokploy would create or change, for the diff shown before apply. */
	create: string[];
	keep: string[];
	/** Rules Dokploy manages but that no longer belong. */
	remove: string[];
};

export interface MeshProvider {
	kind: "netbird" | "headscale";
	/** Reachability plus a human-readable version, for the settings page. */
	test(): Promise<{ ok: boolean; detail: string }>;
	listPeers(): Promise<MeshPeer[]>;
	/** A single-use key that puts a server straight into Dokploy's groups. */
	createEnrollmentKey(name: string): Promise<EnrollmentKey>;
	/** What to run on the server to join, for the given OS family. */
	joinCommand(key: string, hostname: string): string;
	leaveCommand(): string;
	removePeer(peerId: string): Promise<void>;
	/** Idempotent: creates only the `dokploy-*` objects, touches nothing else. */
	ensurePolicy(dryRun: boolean): Promise<PolicyPlan>;
}

export type ProviderContext = {
	baseUrl: string;
	token: string;
	settings: MeshSettings;
};

export const trimUrl = (url: string) => url.trim().replace(/\/+$/, "");

export class MeshApiError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = "MeshApiError";
	}
}

export const request = async <T>(
	context: ProviderContext,
	path: string,
	init: RequestInit & { auth: "token" | "bearer" },
): Promise<T> => {
	const { auth, ...rest } = init;
	const response = await fetch(`${trimUrl(context.baseUrl)}${path}`, {
		...rest,
		headers: {
			accept: "application/json",
			"content-type": "application/json",
			authorization:
				auth === "token" ? `Token ${context.token}` : `Bearer ${context.token}`,
			...(rest.headers ?? {}),
		},
		signal: AbortSignal.timeout(20_000),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new MeshApiError(
			`${init.method ?? "GET"} ${path} failed: ${response.status} ${text.slice(0, 200)}`,
			response.status,
		);
	}
	return (text ? JSON.parse(text) : null) as T;
};
