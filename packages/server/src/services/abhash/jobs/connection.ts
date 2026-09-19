import type { ConnectionOptions } from "bullmq";
import { IS_CLOUD } from "../../../constants";

/**
 * Self-hosted Dokploy has always run a `dokploy-redis` service on the
 * dokploy-network but never set REDIS_URL, so production falls back to it and
 * no new environment variable is needed to upgrade.
 */
export const redisUrl = () =>
	process.env.REDIS_URL ||
	(process.env.NODE_ENV === "production" && !IS_CLOUD
		? "redis://dokploy-redis:6379"
		: "redis://127.0.0.1:6379");

export const connectionOptions = (
	role: "producer" | "worker",
): ConnectionOptions => {
	const url = new URL(redisUrl());
	return {
		host: url.hostname,
		port: Number(url.port || 6379),
		username: url.username ? decodeURIComponent(url.username) : undefined,
		password: url.password ? decodeURIComponent(url.password) : undefined,
		db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
		tls: url.protocol === "rediss:" ? {} : undefined,
		// BullMQ workers block on Redis; ioredis must not give up on them.
		maxRetriesPerRequest: null,
		// Producers fail fast when Redis is down instead of hanging a request;
		// workers keep the offline queue so they reconnect on their own.
		enableOfflineQueue: role === "worker",
		connectTimeout: 5_000,
	};
};

/** Lets a test run keep its jobs apart from a dev server on the same Redis. */
export const queuePrefix = () => process.env.ABHASH_JOBS_PREFIX || "abhash";
