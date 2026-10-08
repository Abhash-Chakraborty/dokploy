import { z } from "zod";
import { getSetting, setSetting } from "./flags";

const KEY = "platform.defaults";

const image = z
	.string()
	.trim()
	.min(1)
	.max(255)
	.regex(/^[a-z0-9][a-z0-9._\-/:@]*$/i, "Not an image reference");

// Every value an admin may want to change without a release. Stored as one
// row so a partial save cannot leave the defaults half-updated.
export const platformDefaultsSchema = z.object({
	databaseImages: z
		.object({
			postgres: image.default("postgres:18"),
			mysql: image.default("mysql:8"),
			mariadb: image.default("mariadb:11"),
			// 8.0 refuses to start on Linux 6.19 and newer.
			mongo: image.default("mongo:8.2"),
			redis: image.default("redis:8"),
			libsql: image.default("ghcr.io/tursodatabase/libsql-server:v0.24.32"),
		})
		.prefault({}),
	// Small image used for one-off jobs on a host, such as reading a folder
	// for a backup.
	helperImage: image.default("alpine:3.20"),
	// Only used when Dokploy creates Traefik from scratch; a recreate keeps
	// whatever image the running container has.
	traefikImage: image.optional(),
	refresh: z
		.object({
			liveStatusSeconds: z.number().int().min(2).max(300).default(10),
			listsSeconds: z.number().int().min(5).max(600).default(15),
			logsSeconds: z.number().int().min(1).max(60).default(5),
		})
		.prefault({}),
	fleetProbeTimeoutSeconds: z.number().int().min(3).max(120).default(12),
});

export type PlatformDefaults = z.infer<typeof platformDefaultsSchema>;

export const getPlatformDefaults = async (): Promise<PlatformDefaults> => {
	// Also read during first-time setup (Traefik), before the database exists.
	const stored = await getSetting<unknown>(KEY, {}).catch(() => ({}));
	const parsed = platformDefaultsSchema.safeParse(stored ?? {});
	return parsed.success ? parsed.data : platformDefaultsSchema.parse({});
};

export const savePlatformDefaults = (
	value: PlatformDefaults,
	updatedBy?: string,
) => setSetting(KEY, platformDefaultsSchema.parse(value), updatedBy);
