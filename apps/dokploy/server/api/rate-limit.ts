import { TRPCError } from "@trpc/server";

/**
 * In-process sliding-window limiter.
 *
 * Deliberately in-memory: this fork runs a single panel process per install
 * (upstream removed the Redis infrastructure), and a per-process ceiling is
 * what protects that process. It is a backstop against runaway clients and
 * scripted abuse, not a billing quota.
 */
interface Bucket {
	count: number;
	resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_TRACKED_KEYS = 50_000;

const prune = (now: number) => {
	for (const [key, bucket] of buckets) {
		if (now >= bucket.resetAt) buckets.delete(key);
	}
	if (buckets.size <= MAX_TRACKED_KEYS) return;
	// Oldest-inserted first; Map preserves insertion order.
	let toDrop = buckets.size - MAX_TRACKED_KEYS;
	for (const key of buckets.keys()) {
		buckets.delete(key);
		if (--toDrop <= 0) break;
	}
};

export interface RateLimitResult {
	allowed: boolean;
	retryAfterSeconds: number;
	remaining: number;
}

export const consume = (
	key: string,
	limit: number,
	windowSeconds: number,
	now = Date.now(),
): RateLimitResult => {
	if (buckets.size > MAX_TRACKED_KEYS) prune(now);

	const bucket = buckets.get(key);
	if (!bucket || now >= bucket.resetAt) {
		buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
		return { allowed: true, retryAfterSeconds: 0, remaining: limit - 1 };
	}

	if (bucket.count >= limit) {
		return {
			allowed: false,
			retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
			remaining: 0,
		};
	}

	bucket.count += 1;
	return {
		allowed: true,
		retryAfterSeconds: 0,
		remaining: limit - bucket.count,
	};
};

/** Exposed so tests can start from a known state. */
export const resetRateLimits = () => buckets.clear();

export const rateLimitError = (retryAfterSeconds: number) =>
	new TRPCError({
		code: "TOO_MANY_REQUESTS",
		message: `Too many requests. Try again in ${retryAfterSeconds}s.`,
	});
