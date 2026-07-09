import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";

import {
  parseMpcParams,
  verifyChain,
  type MpcParams,
} from "@wonderland/cabure-crypto";

import "@/lib/snarkjs-gc-guard";
import { getCeremonyConfig } from "@/lib/ceremony-config";
import { verifyRemote } from "@/lib/external-verifier";
import { loadPtau } from "@/lib/ptau-loader";
import { getParticipant } from "@/lib/participant-auth";
import {
  advanceActiveSlot,
  computeChainHash,
  getCircuitState,
  getManifest,
  hasParticipantContributedToCircuit,
  isCircuitActive,
  kvKey,
  pruneExpiredEntries,
  resolveMaxActiveSeconds,
  type CircuitState,
  type ContributionReceipt,
  type ManifestState,
} from "@/lib/ceremony-state";
import { copyBinary, deleteBinary, putBinary } from "@/lib/blob-store";
import {
  acquireLock,
  releaseLock,
  writeCircuitStateFenced,
  writeContribution,
} from "@/lib/kv-store";

// This route downloads the ptau and genesis, then runs verifyChain — all in
// the request. Pin the function timeout above that budget (ptau 120s + genesis
// 60s + verify), or the platform kills the request before our own AbortSignals
// fire. A Next.js route-segment export; OpenNext maps it to the Lambda timeout,
// so it is not Vercel-specific. Circuits too large to finish under this must
// verify on an external worker instead.
export const maxDuration = 300;
// snarkjs needs Node APIs and worker threads. Never run this route on edge.
export const runtime = "nodejs";

const BLOB_HOST_SUFFIX = ".public.blob.vercel-storage.com";

// TTL for the per-participant verify slot. Sized to the request budget
// (maxDuration) so it outlives the slowest legitimate verify, and so a crashed
// request that never releases the slot frees it within one budget rather than
// locking the participant out indefinitely.
const VERIFY_SLOT_TTL_SECONDS = 300;

// Normalized, byte-free view of a candidate contribution's MPC section (snarkjs
// zkey section 10). Both paths produce this — the offload path from the worker's
// response, the in-process fallback from a local parse — so the continuity gate
// and the commit never touch the zkey bytes.
interface ContributionMpc {
  // sha256 of the exact committed bytes: the download-integrity hash stored in
  // the receipt and re-checked by the client against its own upload.
  computedHash: string;
  // Circuit identity (csHash), constant across the whole chain.
  csHash: string;
  // Number of contributions embedded in this zkey.
  count: number;
  // h_k of the last (new-head) contribution. Null only for an empty chain
  // (count 0), which the continuity gate always rejects.
  headHash: string | null;
  // h_{k-1}: hash of the entry at the head position this builds on
  // (contributions[count - 2]). Null when count < 2.
  linkHash: string | null;
}

// A verified contribution ready to commit: its MPC view plus the coordinator-
// owned blob it now lives at.
interface VerifiedContribution extends ContributionMpc {
  storedUrl: string;
  storedPathname: string;
}

// C-1 continuity check: the upload must extend the recorded head by exactly one,
// judged only from server-side KV state and the (already-computed) MPC view.
// verifyChain proves a zkey is valid from the genesis, not that it extends the
// head — this is what stops a front-of-queue contributor rebasing onto the
// genesis and dropping prior work. Returns an error message, or null if it
// extends the head.
function checkContinuity(
  circuit: CircuitState,
  mpc: Pick<ContributionMpc, "csHash" | "count" | "linkHash">,
): string | null {
  const headCount = circuit.totalContributions;
  if (mpc.count !== headCount + 1) {
    return "Contribution does not extend the current head: wrong contribution count.";
  }
  // Circuit identity is pinned for every submission, not just the first: the
  // csHash is constant across the whole chain, so a mismatch means a wrong or
  // corrupted upload.
  if (mpc.csHash !== circuit.csHash) {
    return "Contribution is for the wrong circuit: csHash mismatch.";
  }
  // Empty chain: there is no head to link to, so the csHash check above is the
  // whole gate.
  if (headCount === 0) {
    return null;
  }
  // count === headCount + 1 here, so linkHash is the hash of
  // contributions[headCount - 1] — the entry that must hash to the recorded
  // head. This ties the upload to the exact chain the coordinator advanced.
  if (mpc.linkHash !== circuit.headContributionHash) {
    return "Contribution does not build on the current head: head hash mismatch.";
  }
  return null;
}

type ContinuityGateResult =
  | { ok: true; serverContributionHash: string }
  | { ok: false; response: NextResponse };

// Authoritative C-1 continuity gate, run inside the per-circuit lock: require the
// contribution to extend the recorded head by exactly one, judged only from KV
// state and the already-computed MPC view (no zkey bytes, no re-parse — the MPC
// view is a pure function of the bytes, so it is computed once, before the lock).
// Any rejection consumes the front-of-queue turn (shifts queue[0]) so a
// participant cannot replay a non-extending upload to block the queue. Mutates
// circuit.queue on rejection; run before the accept-path mutations.
async function runContinuityGate(opts: {
  circuit: CircuitState;
  contribution: VerifiedContribution;
  lockKey: string;
  lockToken: string;
  circuitStateKey: string;
}): Promise<ContinuityGateResult> {
  const { circuit, contribution, lockKey, lockToken, circuitStateKey } = opts;

  const rejectAndConsumeTurn = async (
    error: string,
    status: number,
  ): Promise<ContinuityGateResult> => {
    circuit.queue.shift();
    const consumed = await writeCircuitStateFenced({
      lockKey,
      lockToken,
      circuitStateKey,
      circuitState: circuit,
    });
    await deleteBinary(contribution.storedUrl).catch(() => {});
    // If the fenced write did not land, the lock was lost — the turn was not
    // actually consumed. Report a retry instead of the original rejection, so
    // the response does not imply a turn-consuming outcome that did not happen.
    if (!consumed) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Circuit busy. Please retry." },
          { status: 409 },
        ),
      };
    }
    return { ok: false, response: NextResponse.json({ error }, { status }) };
  };

  const continuityError = checkContinuity(circuit, contribution);
  if (continuityError) {
    return rejectAndConsumeTurn(continuityError, 409);
  }
  // count === headCount + 1 >= 1 once continuity passes, so headHash is always
  // set; guard defensively rather than ever commit a null head.
  if (contribution.headHash === null) {
    return rejectAndConsumeTurn("Contribution has no head hash.", 409);
  }
  return { ok: true, serverContributionHash: contribution.headHash };
}

function isValidPendingBlobUrl(url: string, circuitId: string): boolean {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname.endsWith(BLOB_HOST_SUFFIX)
    ) {
      return false;
    }
    const expectedPrefix = `/contributions/${circuitId}/`;
    return parsed.pathname.startsWith(expectedPrefix);
  } catch {
    return false;
  }
}

type EligibilityResult =
  | { ok: true; circuit: CircuitState }
  | { ok: false; error: string; status: number };

// Shared eligibility gate. Run once cheaply before the heavy verify/upload (so
// a clearly ineligible request never pays for them) and again under the lock,
// where it is authoritative: state can change between the pre-check and
// acquiring the lock. One circuit-state read per call (no global read of every
// circuit); prunes `circuit.queue` in place; the returned circuit is the one to
// mutate and commit.
async function checkEligibility(
  id: string,
  participantId: string,
  manifest: ManifestState,
  targetContributions: number,
  queueTimeoutSeconds: number,
  maxActiveSeconds: number,
): Promise<EligibilityResult> {
  const circuit = await getCircuitState(id);

  if (!isCircuitActive(manifest, circuit, targetContributions)) {
    return { ok: false, error: "Ceremony is not active", status: 403 };
  }

  circuit.queue = pruneExpiredEntries(circuit.queue, queueTimeoutSeconds);
  // Apply the same active-slot cap the queue routes enforce, so a stuck leader
  // who overstayed is rotated off here too and the real next participant passes
  // the front-of-queue check. On the accept path this mutated queue is what
  // writeContribution persists.
  circuit.queue = advanceActiveSlot(circuit.queue, maxActiveSeconds);

  if (circuit.queue[0]?.participantId !== participantId) {
    return { ok: false, error: "Not at front of the queue", status: 409 };
  }

  if (await hasParticipantContributedToCircuit(participantId, id)) {
    return {
      ok: false,
      error: "You have already contributed to this circuit",
      status: 403,
    };
  }

  // finalize:ceremony verifies the chain from the pinned genesis before the
  // beacon. A circuit without that pin can never be finalized, so accepting
  // contributions here would waste participant work.
  if (!circuit.initialZkeyUrl || !circuit.initialZkeyHash) {
    return {
      ok: false,
      error:
        "Ceremony has no pinned genesis and cannot be finalized. " +
        "The operator must re-run init:ceremony.",
      status: 409,
    };
  }

  return { ok: true, circuit };
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const participant = await getParticipant(request);

  if (!participant) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { participantId } = participant;

  const { blobUrl, contributionHash: rawClientHash } =
    (await request.json()) as {
      blobUrl: string;
      contributionHash?: unknown;
    };

  const clientHash =
    typeof rawClientHash === "string" &&
    rawClientHash.length <= 256 &&
    /^0x[0-9a-fA-F]+$/.test(rawClientHash)
      ? rawClientHash
      : null;

  if (!blobUrl || !isValidPendingBlobUrl(blobUrl, id)) {
    return NextResponse.json(
      { error: "Missing or invalid blobUrl" },
      { status: 400 },
    );
  }

  const config = getCeremonyConfig();
  const circuitConfig = config.circuits.find((c) => c.id === id);
  if (!circuitConfig) {
    await deleteBinary(blobUrl).catch(() => {});
    return NextResponse.json(
      { error: `Unknown circuit: ${id}` },
      { status: 404 },
    );
  }

  const manifest = await getManifest();

  // Cheap eligibility check before the expensive verify/upload, so a clearly
  // ineligible request never pays for them. The authoritative check runs again
  // under the lock below. Nothing is stored yet, so on rejection we only clean
  // up the client's pending upload.
  const precheck = await checkEligibility(
    id,
    participantId,
    manifest,
    circuitConfig.targetContributions,
    config.queueTimeoutSeconds,
    resolveMaxActiveSeconds(circuitConfig),
  );
  if (!precheck.ok) {
    await deleteBinary(blobUrl).catch(() => {});
    return NextResponse.json(
      { error: precheck.error },
      { status: precheck.status },
    );
  }

  const mustVerify =
    process.env.NODE_ENV === "production" || config.verifyContributions;
  const externalVerifierUrl = process.env.CEREMONY_VERIFIER_URL?.trim();
  // Bounds the MPC parse (offload: on the worker; fallback: here) so a forged
  // file claiming a huge contribution count is rejected before it is walked. The
  // head cannot advance under a front-of-queue participant, so this pre-check
  // snapshot value is stable for the whole request.
  const maxContributions = precheck.circuit.totalContributions + 1;

  // Single-flight: at most one in-flight verify per participant per circuit.
  // The verify is expensive (ptau download + pairings, on the worker or here);
  // without this a front-of-queue participant could fan out concurrent requests
  // and force parallel verifies (resource and cost DoS). Released in the finally
  // at the end of the request; the TTL frees it if the request dies mid-verify.
  const verifySlotKey = `${config.storage.manifestPath}:verifying:${id}:${participantId}`;
  const verifySlotToken = crypto.randomUUID();
  if (
    !(await acquireLock(verifySlotKey, verifySlotToken, VERIFY_SLOT_TTL_SECONDS))
  ) {
    await deleteBinary(blobUrl).catch(() => {});
    return NextResponse.json(
      {
        error:
          "A verification is already in progress for you on this circuit. Please wait and retry.",
      },
      { status: 429 },
    );
  }

  try {
    // Unique committed path per attempt, never shared: once a contribution
    // commits, currentZkeyUrl points here, and two concurrent attempts from the
    // same participant must not clobber each other's blob. A rejected attempt
    // deletes its own; only a crash leaks one, which the orphan-GC reclaims.
    const zkeyPath = `${config.storage.zkeyPrefix}/${id}/pending-${participantId}-${crypto.randomUUID()}.zkey`;

    let contribution: VerifiedContribution;

    if (mustVerify && externalVerifierUrl) {
      // ===== Offload path: no zkey bytes flow through this function. =====
      // Promote the client's pending upload into a coordinator-owned path with a
      // server-side blob copy (bytes are duplicated inside Blob storage, never
      // downloaded here). We then verify THIS committed copy, which the client
      // cannot overwrite — so the bytes verified are exactly the bytes committed
      // (no TOCTOU), and no per-attempt hash pin is needed. This is what keeps
      // the ~137k-constraint circuits off the function's memory; the in-process
      // fallback below buffers the whole zkey and OOMs on them.
      let stored: { url: string; pathname: string };
      try {
        stored = await copyBinary(blobUrl, zkeyPath);
      } catch (error) {
        console.error(
          `Failed to copy contribution blob for circuit ${id}:`,
          error,
        );
        await deleteBinary(blobUrl).catch(() => {});
        return NextResponse.json(
          { error: "Could not store the contribution. Please retry." },
          { status: 502 },
        );
      }
      // The client's pending upload is now duplicated into our namespace.
      await deleteBinary(blobUrl).catch(() => {});

      // The worker fetches the committed copy, runs the same verifyChain, and
      // returns its MPC view (csHash + head/link hashes + sha256). Same 400/503
      // semantics as the in-process path: a definitive invalid chain is a
      // non-consuming 400; any failure to obtain a verdict is a non-consuming 503
      // (an infra fault must never be charged as an invalid contribution).
      let remote;
      try {
        remote = await verifyRemote({
          url: externalVerifierUrl,
          token: process.env.CEREMONY_VERIFIER_TOKEN,
          ptauUrl: precheck.circuit.ptauUrl,
          genesisUrl: precheck.circuit.initialZkeyUrl,
          genesisSha256: precheck.circuit.initialZkeyHash,
          zkeyUrl: stored.url,
          maxContributions,
        });
      } catch (error) {
        console.error(
          `Remote verification failed to run for circuit ${id}:`,
          error,
        );
        await deleteBinary(stored.url).catch(() => {});
        return NextResponse.json(
          { error: "Verification temporarily unavailable. Please retry." },
          { status: 503 },
        );
      }
      if (!remote.valid) {
        await deleteBinary(stored.url).catch(() => {});
        return NextResponse.json(
          {
            error:
              "Verification failed. If your contribution is valid, please retry.",
          },
          { status: 400 },
        );
      }
      // valid === true guarantees the worker returned the MPC view (verifyRemote
      // validates its shape and throws → 503 otherwise).
      contribution = {
        storedUrl: stored.url,
        storedPathname: stored.pathname,
        computedHash: remote.zkeySha256,
        csHash: remote.csHash,
        count: remote.count,
        headHash: remote.headHash,
        linkHash: remote.linkHash,
      };
    } else {
      // ===== In-process fallback (flag unset: dev / CI / instant rollback). =====
      // Downloads and parses the zkey in-function — memory-heavy, so production
      // sets CEREMONY_VERIFIER_URL to take the offload path above. Kept working so
      // clearing the flag is a real rollback.
      const blobResponse = await fetch(blobUrl);
      if (!blobResponse.ok) {
        return NextResponse.json(
          { error: "Failed to fetch uploaded zkey from blob storage" },
          { status: 400 },
        );
      }
      const body = new Uint8Array(await blobResponse.arrayBuffer());
      if (body.length === 0) {
        await deleteBinary(blobUrl).catch(() => {});
        return NextResponse.json(
          { error: "Contribution payload is empty" },
          { status: 400 },
        );
      }

      let mpc: MpcParams;
      try {
        mpc = await parseMpcParams(body, { maxContributions });
      } catch {
        await deleteBinary(blobUrl).catch(() => {});
        return NextResponse.json(
          { error: "Contribution is not a parseable zkey for this circuit." },
          { status: 400 },
        );
      }

      if (mustVerify) {
        try {
          const ptau = await loadPtau({
            url: precheck.circuit.ptauUrl,
            localPath: circuitConfig.artifacts.ptauPath,
          });
          // Verify against the pinned genesis: download it and confirm it still
          // matches the hash from init, so the chain roots in the real genesis.
          const genesisResponse = await fetch(precheck.circuit.initialZkeyUrl, {
            signal: AbortSignal.timeout(60_000),
          });
          if (!genesisResponse.ok) {
            await deleteBinary(blobUrl).catch(() => {});
            return NextResponse.json(
              { error: "Could not load the pinned genesis to verify against" },
              { status: 502 },
            );
          }
          const genesis = new Uint8Array(await genesisResponse.arrayBuffer());
          const genesisHash = `0x${createHash("sha256").update(genesis).digest("hex")}`;
          if (genesisHash !== precheck.circuit.initialZkeyHash) {
            await deleteBinary(blobUrl).catch(() => {});
            return NextResponse.json(
              { error: "Pinned genesis does not match its recorded hash" },
              { status: 500 },
            );
          }
          const isValid = await verifyChain(ptau, genesis, body);
          if (!isValid) {
            // Don't consume the turn: verifyChain returns false on ANY failure, so
            // an infra fault is indistinguishable from an invalid chain.
            await deleteBinary(blobUrl).catch(() => {});
            return NextResponse.json(
              {
                error:
                  "Verification failed. If your contribution is valid, please retry.",
              },
              { status: 400 },
            );
          }
        } catch (error) {
          console.error(`Verification failed to run for circuit ${id}:`, error);
          await deleteBinary(blobUrl).catch(() => {});
          return NextResponse.json(
            { error: "Verification temporarily unavailable. Please retry." },
            { status: 503 },
          );
        }
      }

      const computedHash = `0x${createHash("sha256").update(body).digest("hex")}`;
      const stored = await putBinary(zkeyPath, body);
      // The client's pending upload has been copied to our path.
      await deleteBinary(blobUrl).catch(() => {});

      const count = mpc.contributions.length;
      contribution = {
        storedUrl: stored.url,
        storedPathname: stored.pathname,
        computedHash,
        csHash: mpc.csHash,
        count,
        headHash: count >= 1 ? mpc.contributions[count - 1].hash() : null,
        linkHash: count >= 2 ? mpc.contributions[count - 2].hash() : null,
      };
    }

    // Critical section: the per-circuit lock serializes this fast commit with the
    // queue POST route, which writes the same circuit-state key. Heavy work
    // already ran above, so the lock is held only for the brief commit and cannot
    // expire mid-write.
    const lockKey = `${config.storage.manifestPath}:lock:${id}`;
    const lockToken = crypto.randomUUID();
    const locked = await acquireLock(lockKey, lockToken);
    if (!locked) {
      await deleteBinary(contribution.storedUrl).catch(() => {});
      return NextResponse.json(
        { error: "Circuit busy. Please retry." },
        { status: 409 },
      );
    }

    try {
      // Authoritative re-check: state may have changed since the pre-check.
      // Re-read the manifest under the lock. A read before the lock could miss
      // the finalizer's seal and let a contribution slip in after it. The only
      // steps between here and the commit are cheap KV reads, so no slow
      // operation can miss the seal. Accepted residual: this is not atomic with
      // the finalizer, which does not hold this lock, so a contribution can still
      // slip past in the tiny gap before commit. Bounded and low severity
      // (operator-triggered finalize; a dropped late contribution does not weaken
      // the setup) — full atomicity needs a shared lock. Deliberate; see PR #62.
      const lockedManifest = await getManifest();
      const eligible = await checkEligibility(
        id,
        participantId,
        lockedManifest,
        circuitConfig.targetContributions,
        config.queueTimeoutSeconds,
        resolveMaxActiveSeconds(circuitConfig),
      );
      if (!eligible.ok) {
        await deleteBinary(contribution.storedUrl).catch(() => {});
        return NextResponse.json(
          { error: eligible.error },
          { status: eligible.status },
        );
      }
      const circuit = eligible.circuit;

      // C-1 continuity gate: require the upload to extend the recorded head. On
      // any rejection it consumes the front-of-queue turn and returns the response
      // to send. Runs before the accept-path mutations below. The resulting
      // serverContributionHash is the new head link, also stored in the receipt
      // for the finalize re-walk.
      const gate = await runContinuityGate({
        circuit,
        contribution,
        lockKey,
        lockToken,
        circuitStateKey: kvKey(config.storage.circuitStatePrefix, id),
      });
      if (!gate.ok) {
        return gate.response;
      }
      const { serverContributionHash } = gate;

      const hadPriorContribution = circuit.totalContributions > 0;
      const previousZkeyUrl = circuit.currentZkeyUrl;
      const contributionIndex = circuit.totalContributions + 1;
      // h_{k-1}: the head this contribution builds on, captured before the head
      // advances below. null for the first contribution (built on genesis). Goes
      // into the receipt so the contributor's attestation can name its
      // predecessor. The open verifier re-derives this from the final zkey, so a
      // wrong value here is detectable, not load-bearing.
      const previousContributionHash = circuit.headContributionHash;
      const timestamp = Date.now();
      // Chain over the genuine contribution hash (h_k), not the SHA-256 of the
      // bytes: only h_k can be rederived from the final zkey, so only this makes
      // the chain verifiable. computedHash stays as the download-integrity hash.
      const chainHash = computeChainHash({
        previousChainHash: circuit.chainHash,
        contributionHash: serverContributionHash,
      });

      circuit.totalContributions += 1;
      circuit.latestContributionHash = contribution.computedHash;
      circuit.chainHash = chainHash;
      circuit.queue.shift();
      circuit.currentZkeyPath = contribution.storedPathname;
      circuit.currentZkeyUrl = contribution.storedUrl;
      // Advance the continuity head: totalContributions (incremented above) is the
      // new head count, and this is the hash the next submission must link to.
      circuit.headContributionHash = serverContributionHash;

      const receipt: ContributionReceipt = {
        circuitId: id,
        participantId,
        contributionIndex,
        contributionHash: contribution.computedHash,
        clientContributionHash: clientHash,
        serverContributionHash,
        previousContributionHash,
        chainHash,
        timestamp,
      };

      const committed = await writeContribution({
        lockKey,
        lockToken,
        circuitStateKey: kvKey(config.storage.circuitStatePrefix, id),
        circuitState: circuit,
        receiptsKey: config.storage.receiptsPath,
        receipt,
        participantContributionsKey: kvKey(
          config.storage.participantContributionsPrefix,
          participantId,
        ),
        circuitId: id,
        participantsIndexKey: config.storage.participantsIndexPath,
        participantId,
      });

      // The write lands only if we still hold the lock. If our lock expired and
      // another writer took it (a stall past the TTL), the commit is rejected:
      // our snapshot is stale, so drop our blob and let the client retry. Do not
      // delete the previous zkey — the other writer now owns it.
      if (!committed) {
        await deleteBinary(contribution.storedUrl).catch(() => {});
        return NextResponse.json(
          { error: "Circuit busy. Please retry." },
          { status: 409 },
        );
      }

      // The new zkey embeds the whole contribution chain, so the previous
      // contribution's blob is redundant — delete it to bound storage. Never
      // delete the genesis (kept when there is no prior contribution).
      if (hadPriorContribution) {
        await deleteBinary(previousZkeyUrl).catch(() => {});
      }

      return NextResponse.json({
        success: true,
        ...receipt,
      });
    } finally {
      // Best-effort: a release can fail on a transient KV error, but the lock's
      // TTL expires it anyway. Letting it throw would replace an already-committed
      // success with a 500 and make the client retry a contribution that landed.
      await releaseLock(lockKey, lockToken).catch((error) => {
        console.error(
          "Failed to release contribution lock for circuit:",
          id,
          error,
        );
      });
    }
  } finally {
    // Free the verify slot on every path (success, rejection, or throw) so the
    // participant can retry without waiting out the TTL. Best-effort: the TTL
    // frees it anyway if this release fails.
    await releaseLock(verifySlotKey, verifySlotToken).catch((error) => {
      console.error("Failed to release verify slot for circuit:", id, error);
    });
  }
}
