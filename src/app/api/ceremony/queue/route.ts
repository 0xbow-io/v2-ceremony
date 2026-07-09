import { NextRequest, NextResponse } from "next/server";

import {
  getAllCircuitStates,
  getCircuitState,
  getManifest,
  getParticipantContributedCircuitIds,
  isCeremonyActive,
  kvKey,
  noShowKey,
  pruneExpiredEntries,
  reconcileFront,
  resolveMaxActiveSeconds,
  selectCircuitsForTier,
} from "@/lib/ceremony-state";
import {
  getCeremonyConfig,
  type CeremonyCircuitConfig,
  type CeremonyTierConfig,
  type TierId,
} from "@/lib/ceremony-config";
import { getParticipant } from "@/lib/participant-auth";
import {
  acquireLock,
  getLockTtlSeconds,
  incrementWithTtl,
  readCounter,
  releaseLock,
  writeCircuitStateFenced,
} from "@/lib/kv-store";

type QueuePosition = {
  participantId: string;
  circuitId: string;
  position: number;
  estimatedWaitSeconds: number;
};

export async function POST(request: NextRequest) {
  const participant = await getParticipant(request);
  if (!participant) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { participantId } = participant;

  const payload = (await request.json()) as {
    tierId?: TierId;
    circuitIds?: string[];
  };

  const config = getCeremonyConfig();
  const manifest = await getManifest();
  const allCircuits = await getAllCircuitStates();

  if (!isCeremonyActive(manifest, allCircuits)) {
    return NextResponse.json(
      { error: "Ceremony is not active" },
      { status: 403 },
    );
  }

  let resolvedIds: string[];
  if (payload.tierId) {
    if (!config.tiersEnabled || !config.tiers || config.tiers.length === 0) {
      return NextResponse.json(
        { error: "This ceremony does not have tiers configured" },
        { status: 400 },
      );
    }
    const tierExists = config.tiers.some(
      (t: CeremonyTierConfig) => t.id === payload.tierId,
    );
    if (!tierExists) {
      const availableTiers = config.tiers
        .map((t: CeremonyTierConfig) => t.id)
        .join(", ");
      return NextResponse.json(
        {
          error: `Invalid tier '${payload.tierId}'. Available tiers are: ${availableTiers}`,
        },
        { status: 400 },
      );
    }
    resolvedIds = selectCircuitsForTier(
      payload.tierId,
      config.tiers,
      config.circuits,
      allCircuits,
    );
  } else if (Array.isArray(payload.circuitIds)) {
    resolvedIds = payload.circuitIds;
  } else {
    return NextResponse.json(
      { error: "Invalid queue payload" },
      { status: 400 },
    );
  }

  if (resolvedIds.length === 0) {
    return NextResponse.json(
      { error: "All circuits in this tier have reached their target" },
      { status: 403 },
    );
  }

  const missingCircuit = resolvedIds.find(
    (circuitId) => !allCircuits.some((circuit) => circuit.id === circuitId),
  );
  if (missingCircuit) {
    return NextResponse.json(
      { error: `Circuit not found: ${missingCircuit}` },
      { status: 404 },
    );
  }

  const contributedCircuitIds =
    await getParticipantContributedCircuitIds(participantId);
  const isCircuitEligible = (circuitConfig: CeremonyCircuitConfig): boolean => {
    if (contributedCircuitIds.has(circuitConfig.id)) {
      return false;
    }

    const circuit = allCircuits.find((state) => state.id === circuitConfig.id);
    return (
      !circuit || circuit.totalContributions < circuitConfig.targetContributions
    );
  };
  const eligibleResolvedIds = resolvedIds.filter((circuitId) => {
    const circuitConfig = config.circuits.find((c) => c.id === circuitId);
    return circuitConfig ? isCircuitEligible(circuitConfig) : false;
  });

  if (eligibleResolvedIds.length === 0) {
    const fallbackCircuitId = config.circuits.find(isCircuitEligible)?.id;

    if (!fallbackCircuitId) {
      return NextResponse.json(
        { error: "You have already contributed to every available circuit." },
        { status: 403 },
      );
    }

    resolvedIds = [fallbackCircuitId];
  } else {
    resolvedIds = eligibleResolvedIds;
  }

  const now = Date.now();
  const positions: QueuePosition[] = [];
  for (const circuitId of resolvedIds) {
    // Block gate (before the lock): a participant who no-showed too many times on
    // this circuit is paused from re-joining until the cooldown lifts, so a tab
    // that will never respond stops being counted as a queue member. 429 +
    // Retry-After tells the client how long to wait. Per-circuit; since circuits
    // are done in order this gates their whole run.
    const noShow = noShowKey(config, circuitId, participantId);
    if ((await readCounter(noShow)) >= config.maxNoShows) {
      const retryAfterSeconds = await getLockTtlSeconds(noShow);
      const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
      return NextResponse.json(
        {
          error: `You were skipped for not responding when your turn came, so you're paused on this circuit. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        },
        {
          status: 429,
          headers:
            retryAfterSeconds > 0
              ? { "Retry-After": String(retryAfterSeconds) }
              : undefined,
        },
      );
    }

    const lockKey = `${config.storage.manifestPath}:lock:${circuitId}`;
    const lockToken = crypto.randomUUID();
    const locked = await acquireLock(lockKey, lockToken);
    if (!locked) {
      return NextResponse.json(
        { error: "Circuit queue busy. Please retry." },
        { status: 409 },
      );
    }

    try {
      const circuit = await getCircuitState(circuitId);
      const key = kvKey(config.storage.circuitStatePrefix, circuitId);

      // Refresh our own entry BEFORE pruning. A join request proves the caller is
      // alive, so their entry is exempt from the timeout: a contributor whose
      // compute ran longer than queueTimeoutSeconds would otherwise be pruned here
      // and re-added at the back, losing their front-of-queue turn — the exact case
      // this refresh exists to protect. Other stale entries are still pruned below.
      const existing = circuit.queue.find(
        (entry) => entry.participantId === participantId,
      );
      if (existing) {
        existing.joinedAt = now;
      }

      circuit.queue = pruneExpiredEntries(
        circuit.queue,
        config.queueTimeoutSeconds,
        now,
      );

      // Reconcile the front: skip a head that never claimed within the claim
      // window (a closed/dead tab), rotate a claimed-but-over-cap head to the
      // back, and stamp the head's clocks. Every caller (including waiters behind
      // the front) runs this under the lock and persists it, so a stuck/dead
      // leader is evicted by the people behind them. Evicted no-shows are counted
      // below (after the write lands).
      const circuitConfig = config.circuits.find((c) => c.id === circuitId);
      let evictedNoShowIds: string[] = [];
      if (circuitConfig) {
        const result = reconcileFront(circuit.queue, {
          now,
          claimWindowSeconds: config.claimWindowSeconds,
          maxActiveSeconds: resolveMaxActiveSeconds(circuitConfig),
        });
        circuit.queue = result.queue;
        evictedNoShowIds = result.evictedNoShowIds;
      }

      let index = circuit.queue.findIndex(
        (entry) => entry.participantId === participantId,
      );

      if (index === -1) {
        circuit.queue.push({
          participantId,
          joinedAt: now,
        });
        index = circuit.queue.length - 1;
      }

      // Latch our claim: ANY POST while we are the head proves we are alive, so we
      // are not a no-show. The client fires a fast claim ping on reaching the
      // front (the 90s heartbeat is too slow for the claim window). Latched once;
      // afterwards the active-slot cap — not the claim window — governs, so a
      // slow-but-live contributor is never skipped.
      if (index === 0 && circuit.queue[0].claimedAt == null) {
        circuit.queue[0].claimedAt = now;
      }

      // Fenced: the state blob also holds the contribution head, so a stale write
      // (expired lock) could revert a contribution that committed in the gap and
      // brick finalize. The fence drops it on lost lock; the client retries.
      const written = await writeCircuitStateFenced({
        lockKey,
        lockToken,
        circuitStateKey: key,
        circuitState: circuit,
      });
      if (!written) {
        return NextResponse.json(
          { error: "Circuit queue busy. Please retry." },
          { status: 409 },
        );
      }

      // Count no-shows only after the eviction actually persisted (a lost-lock
      // write returns above), so we never over-count. The per-circuit lock
      // serializes callers, so a given no-show is counted once.
      for (const evictedId of evictedNoShowIds) {
        await incrementWithTtl(
          noShowKey(config, circuitId, evictedId),
          config.noShowCooldownSeconds,
        );
      }

      positions.push({
        participantId,
        circuitId,
        position: index + 1,
        estimatedWaitSeconds: (index + 1) * 60,
      });
    } finally {
      // Best-effort: a failed release is not fatal (the lock TTL expires it).
      // Throwing here would override the computed response with a 500.
      await releaseLock(lockKey, lockToken).catch((error) => {
        console.error(
          "Failed to release queue lock for circuit:",
          circuitId,
          error,
        );
      });
    }
  }

  return NextResponse.json({ positions });
}

export async function GET(request: NextRequest) {
  const participant = await getParticipant(request);
  if (!participant) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { participantId } = participant;

  const circuitId = request.nextUrl.searchParams.get("circuitId");

  if (!circuitId) {
    return NextResponse.json(
      { error: "circuitId is required" },
      { status: 400 },
    );
  }

  const config = getCeremonyConfig();
  const knownCircuit = config.circuits.find((c) => c.id === circuitId);
  if (!knownCircuit) {
    return NextResponse.json(
      { error: `Circuit not found: ${circuitId}` },
      { status: 404 },
    );
  }
  const circuit = await getCircuitState(circuitId);

  // Read-only: prune AND reconcile the front in memory for an accurate position,
  // but do NOT persist (no counting of no-shows here either). Persisting would
  // overwrite the whole circuit-state key and could revert a concurrent
  // contribution commit. The POST and contribute paths reconcile under the lock
  // and persist it, so this just mirrors what the caller's next claim/heartbeat
  // will make authoritative — which is what advances the caller to position 1 and
  // makes their client fire the contribution.
  const now = Date.now();
  const pruned = pruneExpiredEntries(
    circuit.queue,
    config.queueTimeoutSeconds,
    now,
  );
  const { queue: active } = reconcileFront(pruned, {
    now,
    claimWindowSeconds: config.claimWindowSeconds,
    maxActiveSeconds: resolveMaxActiveSeconds(knownCircuit),
  });

  const index = active.findIndex(
    (entry) => entry.participantId === participantId,
  );

  if (index === -1) {
    return NextResponse.json({ error: "Not in queue" }, { status: 404 });
  }

  return NextResponse.json({
    participantId,
    circuitId,
    position: index + 1,
    estimatedWaitSeconds: (index + 1) * 60,
  });
}
