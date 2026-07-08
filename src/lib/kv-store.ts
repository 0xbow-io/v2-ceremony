import { Redis } from "@upstash/redis";

const LOCK_TTL_SECONDS = 60;

let _redis: Redis | null = null;

function redis(): Redis {
  if (!_redis) {
    const url = process.env.KV_REST_API_URL?.trim();
    const token = process.env.KV_REST_API_TOKEN?.trim();
    if (!url || !token) {
      throw new Error(
        "KV_REST_API_URL and KV_REST_API_TOKEN must be set in the environment.",
      );
    }
    _redis = new Redis({ url, token });
  }
  return _redis;
}

export async function getJson<T>(key: string): Promise<T | null> {
  return (await redis().get<T>(key)) ?? null;
}

// Batch read: one MGET round trip instead of one GET per key. MGET deserializes
// each value exactly as get() does (same base Command deserializer) and returns
// null for missing keys, so callers get the same shape as N getJson() calls —
// but at one Upstash command instead of N. Used by the hot read paths
// (getAllCircuitStates) that the status/queue/eligibility polls hammer.
export async function getJsonMany<T>(keys: string[]): Promise<(T | null)[]> {
  if (keys.length === 0) return [];
  const values = await redis().mget<(T | null)[]>(...keys);
  return keys.map((_, index) => values[index] ?? null);
}

export async function setJson<T>(
  key: string,
  value: T,
  ttlSeconds?: number,
): Promise<void> {
  if (ttlSeconds !== undefined) {
    await redis().set(key, value, { ex: ttlSeconds });
  } else {
    await redis().set(key, value);
  }
}

export async function listPush<T>(key: string, value: T): Promise<void> {
  await redis().rpush(key, value);
}

export async function listRange<T>(key: string): Promise<T[]> {
  return await redis().lrange<T>(key, 0, -1);
}

export async function setIsMember(
  key: string,
  member: string,
): Promise<boolean> {
  const result = await redis().sismember(key, member);
  return Boolean(result);
}

export async function setMembers(key: string): Promise<string[]> {
  return await redis().smembers(key);
}

export async function listClear(key: string): Promise<number> {
  return redis().del(key);
}

// Fence: commit only while the caller still holds the per-circuit lock. KEYS[1]
// is the lock key, ARGV[1] the caller's token. The four writes run only if the
// lock still holds that token, all in one atomic server-side step. See
// writeContribution for why a plain locked write is not enough.
const COMMIT_CONTRIBUTION_SCRIPT = `
  if redis.call("get", KEYS[1]) ~= ARGV[1] then
    return 0
  end
  redis.call("set", KEYS[2], ARGV[2])
  redis.call("rpush", KEYS[3], ARGV[3])
  redis.call("sadd", KEYS[4], ARGV[4])
  redis.call("sadd", KEYS[5], ARGV[5])
  return 1
`;

/**
 * Commit a contribution, but only while the caller still holds the per-circuit
 * lock. Returns false when the lock was lost, so the caller rejects and the
 * client retries. The queue routes take the same lock, so these writes cannot
 * race a concurrent queue update.
 *
 * The lock has a TTL. A process can stall after acquiring it — a GC pause, a
 * slow KV round trip — until the TTL expires and a second writer takes the
 * lock. A plain write would still land and overwrite that second writer,
 * dropping a contribution. The token check makes the advance atomic: the
 * stalled writer sees a different token (or none) and writes nothing. This is
 * the append-only head advance the continuity gate (C-1) builds on.
 *
 * The ARGV values must serialize the way the client's defaultSerializer does,
 * or the readers (getJson, listRange, sismember, smembers) will not parse them.
 * Objects go in as JSON strings; plain string set members go in raw.
 */
export async function writeContribution<TCircuit, TReceipt>(options: {
  lockKey: string;
  lockToken: string;
  circuitStateKey: string;
  circuitState: TCircuit;
  receiptsKey: string;
  receipt: TReceipt;
  participantContributionsKey: string;
  circuitId: string;
  participantsIndexKey: string;
  participantId: string;
}): Promise<boolean> {
  const result = await redis().eval(
    COMMIT_CONTRIBUTION_SCRIPT,
    [
      options.lockKey,
      options.circuitStateKey,
      options.receiptsKey,
      options.participantContributionsKey,
      options.participantsIndexKey,
    ],
    [
      options.lockToken,
      JSON.stringify(options.circuitState),
      JSON.stringify(options.receipt),
      options.circuitId,
      options.participantId,
    ],
  );
  return Number(result) === 1;
}

// Fence for a circuit-state-only write: the same lock-token check as
// writeContribution, without the contribution side effects. Used to persist a
// queue advance when the continuity gate rejects a submission. Returns false if
// the lock was lost, so the caller drops the change.
const COMMIT_CIRCUIT_STATE_SCRIPT = `
  if redis.call("get", KEYS[1]) ~= ARGV[1] then
    return 0
  end
  redis.call("set", KEYS[2], ARGV[2])
  return 1
`;

export async function writeCircuitStateFenced<TCircuit>(options: {
  lockKey: string;
  lockToken: string;
  circuitStateKey: string;
  circuitState: TCircuit;
}): Promise<boolean> {
  const result = await redis().eval(
    COMMIT_CIRCUIT_STATE_SCRIPT,
    [options.lockKey, options.circuitStateKey],
    [options.lockToken, JSON.stringify(options.circuitState)],
  );
  return Number(result) === 1;
}

export async function clearParticipantContributions(options: {
  participantsIndexKey: string;
  participantContributionsPrefix: string;
}): Promise<number> {
  const client = redis();
  const participants = await client.smembers(options.participantsIndexKey);
  if (participants.length > 0) {
    const keys = participants.map(
      (participantId) =>
        `${options.participantContributionsPrefix}:${participantId}`,
    );
    await client.del(...keys);
  }
  await client.del(options.participantsIndexKey);
  return participants.length;
}

// Acquire a single-holder key by SET NX with a TTL. Used both for the brief
// per-circuit commit lock (default TTL) and for the longer-lived verify slot
// that bounds one in-flight verify per participant (caller passes its own TTL).
export async function acquireLock(
  key: string,
  token: string,
  ttlSeconds: number = LOCK_TTL_SECONDS,
): Promise<boolean> {
  const result = await redis().set(key, token, {
    nx: true,
    ex: ttlSeconds,
  });
  return result === "OK";
}

// Seconds remaining on a lock's TTL, for telling a rejected caller how long to
// wait before retrying (e.g. the Retry-After on the verify-slot 429). Returns 0
// when the key is missing or has no expiry, so the caller never advises waiting
// on a slot that has already cleared.
export async function getLockTtlSeconds(key: string): Promise<number> {
  const ttl = await redis().ttl(key);
  return ttl > 0 ? ttl : 0;
}

// Release a lock only if the caller still holds it (token match), so a stalled
// holder whose TTL expired cannot delete a lock a second writer now owns.
const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

export async function releaseLock(key: string, token: string): Promise<void> {
  await redis().eval(RELEASE_LOCK_SCRIPT, [key], [token]);
}
