import { randomUUID } from "node:crypto";

import { getCeremonyConfig } from "./ceremony-config";
import {
  getAllCircuitStates,
  getCircuitState,
  getManifest,
  isCircuitActive,
  kvKey,
  noShowKey,
  type QueueEntry,
} from "./ceremony-state";
import {
  acquireLock,
  getJsonMany,
  releaseLock,
  setMembersMany,
  writeCircuitStateFenced,
} from "./kv-store";

// Enough time for the normal 6s queue poll and a throttled/background tab to
// observe that it was moved before the 30s no-show clock starts.
const HANDOFF_CLAIM_GRACE_MS = 60_000;

export interface QueueHandoffDrainResult {
  busy: boolean;
  migrated: number;
  pending: number;
  terminal: number;
  // Kept internal to the queue route: callers that are still pending must wait
  // for the ordered server-side move instead of racing to append themselves.
  pendingParticipantIds: string[];
  // A no-show cooldown is not a transient handoff lock. Let the normal queue
  // gate return its actionable 429 response for these participants.
  blockedParticipantIds: string[];
}

function circuitLockKey(manifestPath: string, circuitId: string): string {
  return `${manifestPath}:lock:${circuitId}`;
}

function candidateCircuitIds(
  entry: QueueEntry,
  sourceCircuitId: string,
  configuredIds: string[],
): string[] {
  const configured = new Set(configuredIds);
  const raw =
    entry.remainingCircuitIds !== undefined
      ? entry.remainingCircuitIds
      : configuredIds.slice(configuredIds.indexOf(sourceCircuitId) + 1);
  return Array.from(
    new Set(raw.filter((id) => id !== sourceCircuitId && configured.has(id))),
  );
}

/**
 * Drain the durable outbox stored on a completed circuit into later circuit
 * queues. This is deliberately request-driven: any Vercel queue GET/POST can
 * call it, and a failed/timed-out invocation leaves every unfinished entry in
 * the outbox for the next request.
 *
 * Destination effects are at-least-once and idempotent. If Vercel stops after a
 * destination write but before the source outbox is trimmed, the next attempt
 * sees the participant already queued and marks that entry migrated without
 * appending a duplicate.
 */
export async function drainCircuitHandoff(
  sourceCircuitId: string,
): Promise<QueueHandoffDrainResult> {
  const initial = await getCircuitState(sourceCircuitId);
  const initialEntries = initial.pendingHandoff?.entries ?? [];
  if (initialEntries.length === 0) {
    return {
      busy: false,
      migrated: 0,
      pending: 0,
      terminal: 0,
      pendingParticipantIds: [],
      blockedParticipantIds: [],
    };
  }

  const config = getCeremonyConfig();
  const sourceLockKey = circuitLockKey(
    config.storage.manifestPath,
    sourceCircuitId,
  );
  const sourceLockToken = randomUUID();
  if (!(await acquireLock(sourceLockKey, sourceLockToken))) {
    return {
      busy: true,
      migrated: 0,
      pending: initialEntries.length,
      terminal: 0,
      pendingParticipantIds: initialEntries.map(
        (entry) => entry.participantId,
      ),
      blockedParticipantIds: [],
    };
  }

  try {
    const source = await getCircuitState(sourceCircuitId);
    const handoff = source.pendingHandoff;
    if (!handoff || handoff.entries.length === 0) {
      return {
        busy: false,
        migrated: 0,
        pending: 0,
        terminal: 0,
        pendingParticipantIds: [],
        blockedParticipantIds: [],
      };
    }

    const [manifest, states] = await Promise.all([
      getManifest(),
      getAllCircuitStates(),
    ]);
    const configuredIds = config.circuits.map((circuit) => circuit.id);
    const stateById = new Map(states.map((state) => [state.id, state]));
    const configById = new Map(
      config.circuits.map((circuit) => [circuit.id, circuit]),
    );
    const contributedLists = await setMembersMany(
      handoff.entries.map((entry) =>
        kvKey(
          config.storage.participantContributionsPrefix,
          entry.participantId,
        ),
      ),
    );

    const pendingByParticipant = new Map(
      handoff.entries.map((entry, index) => [
        entry.participantId,
        {
          entry,
          contributed: new Set(contributedLists[index] ?? []),
          candidates: candidateCircuitIds(
            entry,
            sourceCircuitId,
            configuredIds,
          ),
        },
      ]),
    );

    const assigned = new Map<string, QueueEntry[]>();
    const assignedCircuitByParticipant = new Map<string, string>();
    const terminalIds = new Set<string>();

    for (const [participantId, item] of pendingByParticipant) {
      // A client may have joined its next circuit before this drain obtained the
      // source lock. Treat that as a successful idempotent handoff.
      const alreadyQueued = item.candidates.find((circuitId) => {
        const state = stateById.get(circuitId);
        const circuitConfig = configById.get(circuitId);
        return (
          !item.contributed.has(circuitId) &&
          state &&
          circuitConfig &&
          isCircuitActive(
            manifest,
            state,
            circuitConfig.targetContributions,
          ) &&
          state.queue.some((entry) => entry.participantId === participantId)
        );
      });

      const destination =
        alreadyQueued ??
        item.candidates.find((circuitId) => {
          const state = stateById.get(circuitId);
          const circuitConfig = configById.get(circuitId);
          return (
            !item.contributed.has(circuitId) &&
            !!state &&
            !!circuitConfig &&
            isCircuitActive(
              manifest,
              state,
              circuitConfig.targetContributions,
            )
          );
        });

      if (!destination) {
        terminalIds.add(participantId);
        continue;
      }

      assignedCircuitByParticipant.set(participantId, destination);
      const group = assigned.get(destination) ?? [];
      group.push(item.entry);
      assigned.set(destination, group);
    }

    // Respect the existing per-circuit no-show cooldown. A blocked participant
    // stays durably pending and will be reconsidered after the TTL expires.
    const assignedItems = Array.from(assignedCircuitByParticipant.entries());
    const noShowCounts = await getJsonMany<number>(
      assignedItems.map(([participantId, circuitId]) =>
        noShowKey(config, circuitId, participantId),
      ),
    );
    const blockedIds = new Set<string>();
    assignedItems.forEach(([participantId], index) => {
      if ((noShowCounts[index] ?? 0) >= config.maxNoShows) {
        blockedIds.add(participantId);
      }
    });

    const migratedIds = new Set<string>();
    const completedIds = new Set(terminalIds);
    let persistedRemainingEntries = handoff.entries;

    const persistSourceProgress = async (): Promise<boolean> => {
      const remainingEntries = handoff.entries.filter(
        (entry) => !completedIds.has(entry.participantId),
      );
      if (remainingEntries.length > 0) {
        source.pendingHandoff = { ...handoff, entries: remainingEntries };
      } else {
        delete source.pendingHandoff;
      }

      const written = await writeCircuitStateFenced({
        lockKey: sourceLockKey,
        lockToken: sourceLockToken,
        circuitStateKey: kvKey(
          config.storage.circuitStatePrefix,
          sourceCircuitId,
        ),
        circuitState: source,
      });
      if (written) persistedRemainingEntries = remainingEntries;
      return written;
    };

    const busyResult = (): QueueHandoffDrainResult => ({
      busy: true,
      migrated: migratedIds.size,
      terminal: terminalIds.size,
      pending: persistedRemainingEntries.length,
      pendingParticipantIds: persistedRemainingEntries.map(
        (entry) => entry.participantId,
      ),
      blockedParticipantIds: Array.from(blockedIds),
    });

    // Remove entries with no remaining eligible circuit immediately. Persisting
    // progress before destination work also bounds repeat work if Vercel stops
    // this invocation later.
    if (terminalIds.size > 0 && !(await persistSourceProgress())) {
      return busyResult();
    }

    for (const [destinationId, rawEntries] of assigned) {
      const entries = rawEntries.filter(
        (entry) => !blockedIds.has(entry.participantId),
      );
      if (entries.length === 0) continue;

      const destinationLockKey = circuitLockKey(
        config.storage.manifestPath,
        destinationId,
      );
      const destinationLockToken = randomUUID();
      if (!(await acquireLock(destinationLockKey, destinationLockToken))) {
        continue;
      }

      try {
        const destination = await getCircuitState(destinationId);
        const destinationConfig = configById.get(destinationId);
        if (
          !destinationConfig ||
          !isCircuitActive(
            manifest,
            destination,
            destinationConfig.targetContributions,
          )
        ) {
          continue;
        }

        // The participant may have independently completed this destination
        // after the batched planning read but before this lock was acquired.
        // Re-read contribution sets while holding the destination lock. A
        // contribution cannot commit under the same lock after this check, so
        // we never append an already-contributed participant back into its queue.
        const freshContributions = await setMembersMany(
          entries.map((entry) =>
            kvKey(
              config.storage.participantContributionsPrefix,
              entry.participantId,
            ),
          ),
        );
        const eligibleEntries = entries.filter(
          (_, index) => !freshContributions[index]?.includes(destinationId),
        );
        if (eligibleEntries.length === 0) continue;

        const existingIds = new Set(
          destination.queue.map((entry) => entry.participantId),
        );
        const migratedAt = Date.now();
        let changed = false;
        for (const entry of eligibleEntries) {
          if (!existingIds.has(entry.participantId)) {
            const item = pendingByParticipant.get(entry.participantId)!;
            const destinationIndex = item.candidates.indexOf(destinationId);
            destination.queue.push({
              participantId: entry.participantId,
              publicToken: entry.publicToken,
              joinedAt: migratedAt,
              remainingCircuitIds:
                destinationIndex >= 0
                  ? item.candidates.slice(destinationIndex + 1)
                  : [],
              handoffGraceUntil: migratedAt + HANDOFF_CLAIM_GRACE_MS,
            });
            existingIds.add(entry.participantId);
            changed = true;
          }
        }

        const written =
          !changed ||
          (await writeCircuitStateFenced({
            lockKey: destinationLockKey,
            lockToken: destinationLockToken,
            circuitStateKey: kvKey(
              config.storage.circuitStatePrefix,
              destinationId,
            ),
            circuitState: destination,
          }));
        if (written) {
          for (const entry of eligibleEntries) {
            migratedIds.add(entry.participantId);
            completedIds.add(entry.participantId);
          }

          // Checkpoint each destination group instead of trimming the source only
          // at the very end. This guarantees forward progress across short-lived
          // Vercel invocations even when one source queue fans out to several
          // different destination circuits.
          if (!(await persistSourceProgress())) {
            return busyResult();
          }
        }
      } finally {
        await releaseLock(destinationLockKey, destinationLockToken).catch(
          () => {},
        );
      }
    }

    return {
      busy: false,
      migrated: migratedIds.size,
      terminal: terminalIds.size,
      pending: persistedRemainingEntries.length,
      pendingParticipantIds: persistedRemainingEntries.map(
        (entry) => entry.participantId,
      ),
      blockedParticipantIds: Array.from(blockedIds),
    };
  } finally {
    await releaseLock(sourceLockKey, sourceLockToken).catch(() => {});
  }
}
