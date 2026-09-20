import { randomUUID } from "node:crypto";
import { queuePrefix } from "./connection";
import { redisClient } from "./queue";

// A counting semaphore in a sorted set scored by lease expiry, so a holder
// that dies without releasing frees its slot once the lease runs out.
const ACQUIRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
  redis.call('PEXPIRE', KEYS[1], ARGV[5])
  return 1
end
return 0`;

const RENEW = `
if redis.call('ZSCORE', KEYS[1], ARGV[2]) then
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  return 1
end
return 0`;

const LEASE_MS = 60_000;

export interface Lease {
	release: () => Promise<void>;
}

const lockKey = (key: string) => `${queuePrefix()}:lock:${key}`;

export const tryAcquire = async (
	key: string,
	limit: number,
): Promise<Lease | null> => {
	const client = await redisClient();
	const token = randomUUID();
	const redisKey = lockKey(key);
	const now = Date.now();
	const acquired = await client.eval(
		ACQUIRE,
		1,
		redisKey,
		now,
		now + LEASE_MS,
		limit,
		token,
		LEASE_MS * 2,
	);
	if (acquired !== 1) return null;
	const renewal = setInterval(() => {
		void client
			.eval(RENEW, 1, redisKey, Date.now() + LEASE_MS, token, LEASE_MS * 2)
			.catch(() => {});
	}, LEASE_MS / 3);
	renewal.unref();
	return {
		release: async () => {
			clearInterval(renewal);
			await client.zrem(redisKey, token).catch(() => 0);
		},
	};
};
