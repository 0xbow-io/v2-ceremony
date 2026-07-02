import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { generateInitialZkey } from "@wonderland/cabure-crypto";
import {
  getCeremonyConfig,
  type CeremonyCircuitConfig,
  type CeremonyTierConfig,
  type TierId,
} from "./ceremony-config";
import { getJson, listRange, setIsMember, setMembers } from "./kv-store";

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
  joinedAt: number;
}

export interface CircuitState {
  id: string;
  totalContributions: number;
  latestContributionHash: string | null;
  chainHash: string;
  queue: QueueEntry[];
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
  return await Promise.all(
    config.circuits.map((circuit) => getCircuitState(circuit.id)),
  );
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

export function pruneExpiredEntries(
  queue: QueueEntry[],
  timeoutSeconds: number,
  now: number = Date.now(),
): QueueEntry[] {
  const timeoutMs = timeoutSeconds * 1000;
  return queue.filter((entry) => now - entry.joinedAt < timeoutMs);
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
