import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { generateInitialZkey } from "@wonderland/cabure-crypto";
import {
  getCeremonyConfig,
  type CeremonyCircuitConfig,
  type CeremonyConfig,
  type CeremonyTierConfig,
  type TierId,
} from "./ceremony-config";
import {
  getJson,
  getJsonMany,
  listRange,
  setIsMember,
  setMembers,
} from "./kv-store";

// Seed of the contribution chain (32 zero bytes).
const GENESIS_CHAIN_HASH = `0x${"0".repeat(64)}`;
const END_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export interface ContributionReceipt {
  circuitId: string;
  participantId: string;
  contributionIndex: number;
  contributionHash: string;
  clientContributionHash: string | null;
  // Server-recomputed Blake2b hash (snarkjs hashPubKey) of the contribution.
  // Distinct from contributionHash (SHA-256 of the bytes) and the untrusted
  // clientContributionHash. finalize re-walks the final zkey and checks this
  // sequence to prove the embedded chain is the one that was recorded.
  serverContributionHash: string;
  // h_{k-1}: the head hash this contribution extended; null for the first
  // contribution. Lets the contributor's attestation name its predecessor.
  previousContributionHash: string | null;
  chainHash: string;
  timestamp: number;
}

export interface QueueEntry {
  participantId: string;
  // Liveness clock. Refreshed on every POST /queue (the client heartbeat), so it
  // only proves the tab is still open — pruneExpiredEntries drops an entry when
  // this ages past queueTimeoutSeconds. NOT a progress signal: a stuck-but-open
  // tab keeps this fresh forever.
  joinedAt: number;
  // Hard progress clock for the ACTIVE slot (queue[0]). Stamped once when a
  // participant reaches the front and never bumped by the heartbeat, so it
  // bounds how long anyone may hold the front regardless of liveness. Only the
  // front entry carries it. See reconcileFront.
  activeSince?: number;
  // Latched (once) the first time the front-runner proves it is alive after
  // reaching the front — any POST /queue while it is the head sets this. Until
  // it is set, the head has only claimWindowSeconds before being skipped as a
  // no-show (a closed/dead tab). Once set, the active-slot cap governs instead,
  // so a slow-but-live contributor is never skipped. Only the front entry
  // carries it. See reconcileFront.
  claimedAt?: number;
  // Opaque random handle for this contributor's run, stable across the circuits
  // they contribute to and never derived from their identity. The public status
  // exposes it only while this entry is the active slot, so consumers can tell
  // contributors apart — and follow one across circuits — without identifying them.
  publicToken?: string;
  // Server-validated remainder of this participant's run. Persisting it on the
  // queue entry lets a completed circuit hand the participant to the correct
  // next circuit without depending on an online browser. Older entries omit it
  // and fall back to ceremony-config order during handoff.
  remainingCircuitIds?: string[];
  // A server-side handoff may place the entry at the next circuit before a
  // background tab observes the transition. Defer the no-show claim clock until
  // this grace point so transferred participants are not immediately evicted.
  handoffGraceUntil?: number;
}

export interface QueueHandoff {
  id: string;
  createdAt: number;
  // Entries not yet durably observed in a destination queue. Destination writes
  // dedupe by participantId, so reprocessing after a Vercel timeout is safe.
  entries: QueueEntry[];
}

export interface CircuitState {
  id: string;
  totalContributions: number;
  latestContributionHash: string | null;
  chainHash: string;
  queue: QueueEntry[];
  // Durable outbox created atomically with the contribution that fills this
  // circuit. Request-driven Vercel functions drain it into later circuits; it is
  // removed only after every entry is migrated or has no eligible destination.
  pendingHandoff?: QueueHandoff;
  currentZkeyPath: string;
  currentZkeyUrl: string;
  // Genesis zkey, pinned at init and never overwritten. Lets the contribution
  // and finalize paths check that a chain really extends the original
  // parameters instead of trusting the mutable `current` pointer.
  initialZkeyHash: string;
  initialZkeyUrl: string;
  // Public URL of the ptau this circuit was set up with, published at init. The
  // file is not on the deployed function's filesystem; the contribute route
  // fetches it here for verifyChain. Per-circuit so circuits may use different
  // (right-sized) ptau files. Required: init always publishes it.
  ptauUrl: string;
  // Continuity anchors snarkjs cannot give us: it proves a zkey is valid from the
  // genesis, not that it extends the recorded head. The head count is
  // `totalContributions`; the two fields below are the cryptographic anchors the
  // contribute gate checks, and come only from server state.
  //
  // Blake2b (hashPubKey) of the head's last contribution; null at genesis. A
  // submission must carry this exact hash at the head position.
  headContributionHash: string | null;
  // Circuit identity (csHash) from the genesis MPC params, the same across the
  // whole chain. The empty-chain gate checks the first submission against it.
  csHash: string;
}

export interface ManifestState {
  ceremonyName: string;
  targetContributions: number;
  endDate: string | null;
  startedAt: number;
  circuits: Array<{ id: string }>;
  // Resolved beacon, persisted at seal time so an interrupted finalize reuses
  // the same value on recovery and can never re-roll it. See finalize-ceremony.
  beaconHash?: string;
  beaconSource?: string;
  beaconSlot?: number;
  beaconApplied?: boolean;
  finalizingAt?: number;
  finalizedAt?: number;
}

export async function getManifest(): Promise<ManifestState> {
  const config = getCeremonyConfig();
  const manifest = await getJson<ManifestState>(config.storage.manifestPath);
  if (!manifest) {
    throw new Error("Ceremony not initialized. Run init:ceremony.");
  }
  return manifest;
}

export async function getCircuitState(
  circuitId: string,
): Promise<CircuitState> {
  const config = getCeremonyConfig();
  const state = await getJson<CircuitState>(
    kvKey(config.storage.circuitStatePrefix, circuitId),
  );
  if (!state) {
    throw new Error(
      `Missing circuit state for ${circuitId}. Run init:ceremony.`,
    );
  }
  return state;
}

export async function getAllCircuitStates(): Promise<CircuitState[]> {
  const config = getCeremonyConfig();
  // One MGET, not one GET per circuit. This is the hot read path behind the
  // status/queue/eligibility polls; with ~27 circuits the per-key version fired
  // ~27 Upstash commands per request, which is what exhausted the KV request
  // quota under load. Batching keeps it at a single command.
  const states = await getJsonMany<CircuitState>(
    config.circuits.map((circuit) =>
      kvKey(config.storage.circuitStatePrefix, circuit.id),
    ),
  );
  return states.map((state, index) => {
    if (!state) {
      throw new Error(
        `Missing circuit state for ${config.circuits[index].id}. Run init:ceremony.`,
      );
    }
    return state;
  });
}

export async function getReceipts(): Promise<ContributionReceipt[]> {
  const config = getCeremonyConfig();
  return await listRange<ContributionReceipt>(config.storage.receiptsPath);
}

export async function getParticipantContributedCircuitIds(
  participantId: string,
): Promise<Set<string>> {
  const config = getCeremonyConfig();
  const circuitIds = await setMembers(
    kvKey(config.storage.participantContributionsPrefix, participantId),
  );
  return new Set(circuitIds);
}

export async function hasParticipantContributedToCircuit(
  participantId: string,
  circuitId: string,
): Promise<boolean> {
  const config = getCeremonyConfig();
  return await setIsMember(
    kvKey(config.storage.participantContributionsPrefix, participantId),
    circuitId,
  );
}

export function getEndDateDeadlineMs(endDate: string | null): number | null {
  if (endDate === null) {
    return null;
  }

  const normalizedEndDate = endDate.trim();
  if (!normalizedEndDate) {
    return null;
  }

  if (!END_DATE_REGEX.test(normalizedEndDate)) {
    throw new Error(
      `Invalid ceremony endDate "${endDate}". Expected YYYY-MM-DD.`,
    );
  }

  const [year, month, day] = normalizedEndDate.split("-").map(Number);
  const deadlineMs = Date.parse(`${normalizedEndDate}T23:59:59Z`);
  const deadline = new Date(deadlineMs);
  if (
    Number.isNaN(deadlineMs) ||
    deadline.getUTCFullYear() !== year ||
    deadline.getUTCMonth() !== month - 1 ||
    deadline.getUTCDate() !== day
  ) {
    throw new Error(
      `Invalid ceremony endDate "${endDate}". Expected a valid calendar date.`,
    );
  }

  return deadlineMs;
}

export function isCeremonyActive(
  manifest: ManifestState,
  allCircuits: CircuitState[],
): boolean {
  const config = getCeremonyConfig();
  const now = Date.now();
  // Hard seal. The ceremony stops accepting contributions for good once
  // finalization starts: beaconApplied means it finished, finalizingAt means a
  // finalize:ceremony run is in progress or was interrupted. Neither expires on
  // its own. Auto-reopening would let contributions resume while a finalizer is
  // still working from its snapshot, and they would be dropped from the final
  // artifacts. An interrupted run is recovered explicitly: finalize --force to
  // take over and resume, or reset:ceremony to start clean.
  if (manifest.beaconApplied || manifest.finalizingAt !== undefined) {
    return false;
  }
  let endDateMs: number | null;
  try {
    endDateMs = getEndDateDeadlineMs(manifest.endDate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Ceremony inactive because manifest.endDate is invalid: ${message}`,
    );
    return false;
  }
  const deadlinePassed = endDateMs !== null && now > endDateMs;
  if (deadlinePassed) return false;
  return config.circuits.some((c) => {
    const state = allCircuits.find((s) => s.id === c.id);
    return !state || state.totalContributions < c.targetContributions;
  });
}

/**
 * Whether one circuit can still accept a contribution: the ceremony deadline
 * has not passed and this circuit is below its target. Per-circuit, so it needs
 * only this circuit's state — no global read of every circuit. The contribute
 * path uses this instead of isCeremonyActive: a contribution to a full circuit
 * must be rejected even while other circuits are still open.
 */
export function isCircuitActive(
  manifest: ManifestState,
  circuit: CircuitState,
  targetContributions: number,
): boolean {
  // Same hard seal as isCeremonyActive. The contribute path uses this function
  // and is the only one that overwrites current.zkey, so without this check a
  // --force early finalize would let contributions slip in during finalization.
  if (manifest.beaconApplied || manifest.finalizingAt !== undefined) {
    return false;
  }
  let endDateMs: number | null;
  try {
    endDateMs = getEndDateDeadlineMs(manifest.endDate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Ceremony inactive because manifest.endDate is invalid: ${message}`,
    );
    return false;
  }
  if (endDateMs !== null && Date.now() > endDateMs) return false;
  return circuit.totalContributions < targetContributions;
}

/**
 * Resolves which circuits a participant should queue for given their selected
 * tier. Drops circuits that have already reached their per-circuit target and
 * backfills with the most underserved circuits from the full config, up to the
 * original tier's circuit count.
 */
export function selectCircuitsForTier(
  tierId: TierId,
  tiers: CeremonyTierConfig[],
  circuitConfigs: CeremonyCircuitConfig[],
  allCircuits: CircuitState[],
): string[] {
  const tier = tiers.find((t) => t.id === tierId);
  if (!tier) return [];
  const maxCount = tier.circuitIds.length;

  const needed = tier.circuitIds.filter((id) => {
    const conf = circuitConfigs.find((c) => c.id === id);
    const state = allCircuits.find((s) => s.id === id);
    if (!conf || !state) return true;
    return state.totalContributions < conf.targetContributions;
  });

  if (needed.length >= maxCount) return needed;

  const alreadyIncluded = new Set(needed);
  const candidates = circuitConfigs
    .filter((c) => !alreadyIncluded.has(c.id))
    .map((c) => {
      const state = allCircuits.find((s) => s.id === c.id);
      const remaining =
        c.targetContributions - (state?.totalContributions ?? 0);
      return { id: c.id, remaining };
    })
    .filter((c) => c.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining);

  const backfill = candidates
    .slice(0, maxCount - needed.length)
    .map((c) => c.id);

  return [...needed, ...backfill];
}

// Chain-of-custody over the genuine per-contribution hashes. Each link is
// SHA-256(previousChainHash ‖ h_k), where h_k is the contribution's Blake2b
// hash (serverContributionHash, snarkjs hashPubKey) recomputed server-side from
// the submitted zkey. Both operands are folded as raw bytes, not as text.
//
// Chaining over h_k, not operator-controlled strings (SHA-256 of the bytes,
// participantId, timestamp), keeps the chain tied to values that exist in the
// final zkey's section 10: the same sequence can be recomputed from the
// published parameters. The attestation publishes each h_k and this chain hash.
export function computeChainHash(options: {
  previousChainHash: string;
  contributionHash: string;
}): string {
  const prev = Buffer.from(options.previousChainHash.replace(/^0x/, ""), "hex");
  const hk = Buffer.from(options.contributionHash.replace(/^0x/, ""), "hex");
  const digest = createHash("sha256").update(prev).update(hk).digest("hex");
  return `0x${digest}`;
}

export async function generateGenesisZkey(artifacts: {
  r1csPath: string;
  ptauPath: string;
}): Promise<Uint8Array> {
  const r1cs = await readCircuitBytes(artifacts.r1csPath);
  const ptau = await readCircuitBytes(artifacts.ptauPath);
  return await generateInitialZkey(ptau, r1cs);
}

export function createCircuitState(options: {
  id: string;
  zkeyPath: string;
  zkeyUrl: string;
  initialZkeyHash: string;
  initialZkeyUrl: string;
  ptauUrl: string;
  csHash: string;
}): CircuitState {
  return {
    id: options.id,
    totalContributions: 0,
    latestContributionHash: null,
    chainHash: GENESIS_CHAIN_HASH,
    queue: [],
    currentZkeyPath: options.zkeyPath,
    currentZkeyUrl: options.zkeyUrl,
    initialZkeyHash: options.initialZkeyHash,
    initialZkeyUrl: options.initialZkeyUrl,
    ptauUrl: options.ptauUrl,
    headContributionHash: null,
    csHash: options.csHash,
  };
}

// Opaque public handle for a contributor's run (see QueueEntry.publicToken).
export function mintContributorToken(): string {
  return `c_${randomUUID().replace(/-/g, "")}`;
}

// KV key holding a participant's opaque run token, so it stays stable across the
// circuits they contribute to one after another.
export function runTokenKey(
  config: CeremonyConfig,
  participantId: string,
): string {
  return kvKey(config.storage.runTokenPrefix, participantId);
}

export function pruneExpiredEntries(
  queue: QueueEntry[],
  timeoutSeconds: number,
  now: number = Date.now(),
): QueueEntry[] {
  const timeoutMs = timeoutSeconds * 1000;
  return queue.filter((entry) => now - entry.joinedAt < timeoutMs);
}

// How long a participant may hold the front-of-queue (active) slot before being
// rotated to the back. This is the hard cap the queue timeout can no longer
// provide on its own: the client heartbeat keeps joinedAt fresh, so an open tab
// is never pruned, so without this a slow or stuck front-runner blocks everyone.
// Bounds below; the middle scales with circuit size (download + compute + the
// server-side verify all grow with the constraint count).
const ACTIVE_SLOT_FLOOR_SECONDS = 120; // 2 min — deposit/ragequit floor (they finish well under this)
const ACTIVE_SLOT_CEIL_SECONDS = 600; // 10 min hard ceiling
const ACTIVE_SLOT_BASE_SECONDS = 90; // fixed overhead budget (download + verify)
const ACTIVE_SLOT_CONSTRAINTS_PER_SECOND = 400; // added budget: 1s per 400 constraints of compute headroom

// Parse a constraint count that may be formatted with thousands separators
// ("142,741" -> 142741). Returns NaN when unparseable so callers can fall back
// to the most generous cap rather than risk kicking honest contributors.
export function parseConstraintCount(constraints: string): number {
  const digits = constraints.replace(/[^0-9]/g, "");
  return digits.length > 0 ? Number(digits) : Number.NaN;
}

// Per-circuit active-slot cap derived from the circuit's constraint count. Falls
// back to the ceiling (most lenient) if the count can't be parsed — never kick
// on bad config data.
export function deriveMaxActiveSeconds(constraints: string): number {
  const count = parseConstraintCount(constraints);
  if (Number.isNaN(count)) return ACTIVE_SLOT_CEIL_SECONDS;
  const seconds =
    ACTIVE_SLOT_BASE_SECONDS + count / ACTIVE_SLOT_CONSTRAINTS_PER_SECOND;
  const rounded = Math.round(seconds / 30) * 30;
  return Math.min(
    ACTIVE_SLOT_CEIL_SECONDS,
    Math.max(ACTIVE_SLOT_FLOOR_SECONDS, rounded),
  );
}

// The effective cap for a circuit: an explicit config override wins, else the
// size-derived default.
export function resolveMaxActiveSeconds(
  circuitConfig: CeremonyCircuitConfig,
): number {
  return (
    circuitConfig.maxActiveSeconds ??
    deriveMaxActiveSeconds(circuitConfig.constraints)
  );
}

export interface ReconcileFrontResult {
  queue: QueueEntry[];
  // Participants removed as no-shows this call. A persisting caller counts each
  // toward the no-show limit; read-only callers ignore it.
  evictedNoShowIds: string[];
}

export interface ReconcileFrontOptions {
  now?: number;
  // Grace to CLAIM after reaching the front (unclaimed past this → no-show skip).
  claimWindowSeconds: number;
  // Hard cap for a CLAIMED (live, working) front-runner before rotation.
  maxActiveSeconds: number;
}

// Reconcile the front of the queue against its two clocks, returning a NEW queue
// plus any ids skipped as no-shows. Call AFTER pruneExpiredEntries, on any read
// of a circuit's queue. Rules, in order:
//   - only the front (queue[0]) holds the slot, so stray activeSince/claimedAt on
//     entries behind it is cleared;
//   - a head that has NOT claimed within claimWindowSeconds of reaching the front
//     is a no-show (a closed/dead tab): it is EVICTED (removed, not rotated — a
//     closed tab gets no second turn) and its id returned so the caller can count
//     it toward the block;
//   - a head that HAS claimed but held the slot past maxActiveSeconds overran the
//     cap: it is rotated to the BACK so the line advances. Guarded by length > 1
//     so a LONE head can never rotate onto itself and reset its own clock (the
//     bug that let a single front-runner bypass the cap indefinitely);
//   - whoever is at the front afterwards gets activeSince stamped so its clocks
//     start.
// At most one head is resolved per call; the promoted entry starts fresh. Pure
// and idempotent — leaves the input untouched — so it is safe on both persisted
// (POST/contribute) and read-only (GET/upload) paths.
export function reconcileFront(
  queue: QueueEntry[],
  options: ReconcileFrontOptions,
): ReconcileFrontResult {
  const now = options.now ?? Date.now();
  const claimWindowMs = options.claimWindowSeconds * 1000;
  const maxActiveMs = options.maxActiveSeconds * 1000;
  const evictedNoShowIds: string[] = [];

  const next = queue.map((entry) => ({ ...entry }));
  for (let i = 1; i < next.length; i++) {
    next[i].activeSince = undefined;
    next[i].claimedAt = undefined;
  }

  const front = next[0];
  if (front && front.activeSince != null) {
    const claimClockStartedAt = Math.max(
      front.activeSince,
      front.handoffGraceUntil ?? 0,
    );
    if (
      front.claimedAt == null &&
      now - claimClockStartedAt > claimWindowMs
    ) {
      // No-show: reached the front but never proved it is alive. Remove it (a
      // closed tab gets no rotation) and report it for the no-show counter.
      evictedNoShowIds.push(front.participantId);
      next.shift();
    } else if (
      front.claimedAt != null &&
      now - front.activeSince > maxActiveMs &&
      next.length > 1
    ) {
      // Overtime: claimed and working, but overran the cap. Rotate to the back so
      // the line advances. length > 1 prevents a lone head from rotating onto
      // itself (which would reset its clock); with no one waiting it simply keeps
      // the slot until someone joins.
      const kicked = next.shift()!;
      kicked.activeSince = undefined;
      kicked.claimedAt = undefined;
      kicked.joinedAt = now;
      next.push(kicked);
    }
  }

  if (next[0] && next[0].activeSince == null) {
    next[0].activeSince = now;
  }

  return { queue: next, evictedNoShowIds };
}

// KV key for a participant's no-show counter on a circuit. Per-circuit: a block
// on the current circuit gates their whole run (circuits are done in order).
export function noShowKey(
  config: CeremonyConfig,
  circuitId: string,
  participantId: string,
): string {
  return `${config.storage.noShowPrefix}:${circuitId}:${participantId}`;
}

export function kvKey(prefix: string, suffix: string): string {
  return `${prefix}:${suffix}`;
}

export async function readCircuitBytes(
  relativePath: string,
): Promise<Uint8Array> {
  const fullPath = path.resolve(process.cwd(), relativePath);
  try {
    const data = await readFile(fullPath);
    return new Uint8Array(data);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `Missing circuit artifact: ${relativePath}. Add it to the circuits/ folder.`,
      );
    }
    throw error;
  }
}
