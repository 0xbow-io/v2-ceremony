"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  ApiError,
  getParticipantEligibility,
  getQueuePosition,
  getZkeyInfo,
  joinQueue,
  submitContribution,
  uploadZkey,
  type ReceiptResponse,
} from "@/lib/api";
import type {
  CircuitRunItem,
  CircuitRunStatus,
  ContribPhase,
} from "@/app/screens/ProgressScreen";
import type { ClientCircuitConfig } from "@/lib/ceremony-config";
import { runContribution } from "@/lib/worker-client";
import { deriveEntropy, sha256 } from "@/utils/entropy";

// Total attempts (initial + automatic retries) before giving up and surfacing
// the manual Retry/Cancel buttons. The first failure triggers attempt #2, and so
// on; once MAX_ATTEMPTS attempts have failed the error is shown as before.
const MAX_ATTEMPTS = 3;

// A 429 from /contribute means our per-participant verify slot is still held
// (usually a prior attempt that died before releasing it). It clears within its
// TTL, so we wait it out rather than burning the MAX_ATTEMPTS budget on instant
// retries that all bounce off the lock. The wait honours the server's
// Retry-After, clamped to this window so the UI is not frozen for minutes per
// wait and a too-large header value can't stall the flow.
const SLOT_WAIT_MIN_SECONDS = 5;
const SLOT_WAIT_MAX_SECONDS = 30;
// Cap on consecutive slot waits before we stop waiting and surface the error,
// so a slot that never clears (rather than just lingering) can't loop forever.
const MAX_SLOT_WAITS = 10;

// Keep the current circuit's queue slot alive while we hold it. A slot only stays
// fresh via a POST /queue (which bumps joinedAt) — the position poll is a
// read-only GET and is paused during compute. Without a heartbeat, a wait or a
// compute longer than the server's queueTimeoutSeconds (300s default) ages the
// slot out: the participant silently loses their turn, and their already-computed
// contribution is then rejected for building on a stale head. 90s leaves ~3 beats
// of margin under the 300s default and must stay comfortably below it.
const QUEUE_HEARTBEAT_MS = 90_000;

// Fast "I'm here" claim ping once we reach the FRONT. The server skips a head
// that never proves it is alive within claimWindowSeconds (~30s) as a no-show (a
// closed/dead tab), so the 90s heartbeat is too slow to claim the slot. Any POST
// /queue while we are the head latches the claim server-side; after that the
// generous active-slot cap governs and a slow-but-live contributor is safe. We
// ping every 10s but only a few times (covering the ~30s window with retry
// margin), then stop so a long compute isn't spammed with POSTs.
const CLAIM_PING_MS = 10_000;
const CLAIM_MAX_PINGS = 4;

// Server receipt plus the contributor's OWN h_k, computed client-side
// (`result.contributionHash` from contribute(), not the server's
// `serverContributionHash`). The attestation publishes this so it is the
// contributor's own statement and can surface an operator that recorded a
// different hash. See CompleteScreen.
export interface ContributionReceiptWithClient extends ReceiptResponse {
  clientHk: string;
}

export interface ContributionFlowState {
  circuitRuns: CircuitRunItem[];
  currentCircuitIndex: number;
  currentCircuitId: string | null;
  currentCircuit: ClientCircuitConfig | undefined;
  // Estimated seconds until the whole contribution finishes, derived from the
  // user's measured throughput. Null while there is no rate to extrapolate yet.
  estimatedSecondsRemaining: number | null;
  contributionPhase: ContribPhase;
  contributionProgress: number;
  contributionError: string | null;
  queueError: string | null;
  finalizeReady: boolean;
  receipts: ContributionReceiptWithClient[];
  // Auto-retry: while a failed contribution/queue step is being retried
  // automatically, `autoRetrying` is true, `autoRetryMessage` holds the error
  // that triggered it, and `autoRetryAttempt`/`autoRetryMax` describe progress
  // ("attempt N of MAX"). Once attempts are exhausted these reset and the
  // manual error (contributionError/queueError) is surfaced instead.
  autoRetrying: boolean;
  autoRetryMessage: string | null;
  autoRetryAttempt: number;
  autoRetryMax: number;
}

export interface JoinOptions {
  tierId?: string;
  circuitIds?: string[];
}

export interface ContributionFlowActions {
  joinAndStart: (options: JoinOptions, circuits: ClientCircuitConfig[]) => Promise<void>;
  retry: () => void;
  cancel: () => void;
  reset: () => void;
}

export function useContributionFlow(options: {
  entropySeed: Uint8Array | null;
  selectedCircuitIds: string[];
  circuits: ClientCircuitConfig[];
  active: boolean;
}): ContributionFlowState & ContributionFlowActions {
  const {
    entropySeed,
    selectedCircuitIds,
    circuits,
    active: flowActive,
  } = options;

  const queryClient = useQueryClient();

  const [circuitRuns, setCircuitRuns] = useState<CircuitRunItem[]>([]);
  const [resolvedCircuitIds, setResolvedCircuitIds] = useState<string[]>([]);
  const [currentCircuitIndex, setCurrentCircuitIndex] = useState(0);
  const [flowRunId, setFlowRunId] = useState(0);
  const [finalizeReady, setFinalizeReady] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [contributionPhase, setContributionPhase] =
    useState<ContribPhase>("downloading");
  const [contributionProgress, setContributionProgress] = useState(0);
  const [contributionError, setContributionError] = useState<string | null>(
    null,
  );
  const [receipts, setReceipts] = useState<ContributionReceiptWithClient[]>([]);

  // Auto-retry display state. `attemptsRef` counts consecutive failed attempts
  // in the current cycle (reset on success, a fresh start, or a manual retry);
  // it lives in a ref so the failure handlers read the latest count without
  // depending on a re-render.
  const [autoRetrying, setAutoRetrying] = useState(false);
  const [autoRetryMessage, setAutoRetryMessage] = useState<string | null>(null);
  const [autoRetryAttempt, setAutoRetryAttempt] = useState(0);
  const attemptsRef = useRef(0);
  // Pending verify-slot wait (see waitThenRetry); tracked so every reset path
  // cancels it and so consecutive waits are bounded by MAX_SLOT_WAITS.
  const slotWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slotWaitsRef = useRef(0);
  // Count of fast claim pings sent for the current FRONT TURN, so we stop after
  // CLAIM_MAX_PINGS instead of spamming through a long compute. Reset on each
  // fresh entry into the front (see atFrontRef), so a participant rotated to the
  // back and cycling around again re-claims on their next turn.
  const claimPingsRef = useRef(0);
  // Tracks whether we were at the front on the previous render, to detect the
  // transition INTO the front (the start of a new front turn).
  const atFrontRef = useRef(false);

  const clearAutoRetry = useCallback(() => {
    attemptsRef.current = 0;
    slotWaitsRef.current = 0;
    if (slotWaitTimerRef.current !== null) {
      clearTimeout(slotWaitTimerRef.current);
      slotWaitTimerRef.current = null;
    }
    setAutoRetrying(false);
    setAutoRetryMessage(null);
    setAutoRetryAttempt(0);
  }, []);

  // Cancel any pending slot-wait timer when the component unmounts.
  useEffect(() => {
    return () => {
      if (slotWaitTimerRef.current !== null) {
        clearTimeout(slotWaitTimerRef.current);
      }
    };
  }, []);

  const contributionAbortRef = useRef<AbortController | null>(null);

  // --- Live ETA timing ---
  // Measures the user's actual throughput (circuit constraints processed per
  // millisecond) from completed circuits, then extrapolates over the remaining
  // ones. This is hardware-adaptive: a slow machine simply measures a slower
  // rate. circuitComputeStartRef marks when the active circuit's work began;
  // on completion its elapsed time and constraint weight fold into the running
  // totals below.
  const circuitComputeStartRef = useRef<number | null>(null);
  const measuredComputeMsRef = useRef(0);
  const measuredWeightRef = useRef(0);

  const parseConstraints = (value: string): number =>
    Number(value.replace(/[^0-9]/g, "")) || 0;
  const weightById = new Map(
    circuits.map((circuit) => [circuit.id, parseConstraints(circuit.constraints)]),
  );

  const resetEtaTracking = useCallback(() => {
    circuitComputeStartRef.current = null;
    measuredComputeMsRef.current = 0;
    measuredWeightRef.current = 0;
  }, []);

  // The active list is ONLY the server-eligibility-resolved list (set by
  // joinAndStart). It must not fall back to selectedCircuitIds: if resolution
  // yields nothing (already contributed to everything), currentCircuitId stays
  // null so the queue poll / heartbeat / rejoin machinery never runs for a
  // circuit the participant can't contribute to.
  const activeCircuitIds = resolvedCircuitIds;
  const currentCircuitId = activeCircuitIds[currentCircuitIndex] ?? null;
  const currentCircuit = circuits.find(
    (circuit) => circuit.id === currentCircuitId,
  );

  const updateCircuitRun = useCallback(
    (circuitId: string, patch: Partial<CircuitRunItem>) => {
      setCircuitRuns((prev) =>
        prev.map((circuit) =>
          circuit.id === circuitId ? { ...circuit, ...patch } : circuit,
        ),
      );
    },
    [],
  );

  const markCircuitStatus = useCallback(
    (circuitId: string, status: CircuitRunStatus) => {
      updateCircuitRun(circuitId, { status });
    },
    [updateCircuitRun],
  );

  // --- Contribution mutation (download → compute → upload) ---

  const contributeMutation = useMutation({
    mutationFn: async (circuitId: string) => {
      const seed = entropySeed!;

      const controller = new AbortController();
      contributionAbortRef.current = controller;

      markCircuitStatus(circuitId, "active");
      setContributionError(null);
      setQueueError(null);
      setContributionPhase("downloading");
      setContributionProgress(0);
      circuitComputeStartRef.current = Date.now();

      const zkeyInfo = await getZkeyInfo(circuitId, controller.signal);
      const zkeyResponse = await fetch(zkeyInfo.url, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!zkeyResponse.ok) {
        throw new Error("Failed to download zkey.");
      }
      const zkey = new Uint8Array(await zkeyResponse.arrayBuffer());

      if (zkeyInfo.hash) {
        const digest = await sha256(zkey);
        const hex = `0x${Array.from(digest).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
        if (hex !== zkeyInfo.hash) {
          throw new Error(
            "Zkey integrity check failed: downloaded file does not match expected hash.",
          );
        }
      }

      setContributionProgress(15);
      setContributionPhase("computing");

      const entropy = await deriveEntropy(seed, circuitId);
      const result = await runContribution({
        prevZkey: zkey,
        entropy,
        name: "contributor",
        onProgress: (percent) => {
          setContributionProgress(15 + percent * 0.7);
        },
        signal: controller.signal,
      });

      // Refresh our queue entry now that the long compute is done, BEFORE the
      // upload and submit. Both prune the queue and reject anyone not at the front,
      // and a compute longer than queueTimeoutSeconds would otherwise have aged our
      // entry out. Bumping joinedAt (see the queue POST) keeps it alive through
      // upload + verify.
      try {
        await joinQueue({ circuitIds: [circuitId], signal: controller.signal });
      } catch (error) {
        // If the user cancelled, re-throw so the mutation exits here. Otherwise the
        // next state update would flash the UI to "uploading" after a cancel. Any
        // other error is best-effort: a later step may be rejected and retried.
        if (controller.signal.aborted) throw error;
      }

      setContributionPhase("uploading");
      setContributionProgress(85);

      const blobUrl = await uploadZkey({
        circuitId,
        payload: result.zkey,
        signal: controller.signal,
      });

      // The submit POST runs the mandatory server-side verifyChain, seconds on
      // large circuits. Distinct phase so the contributor sees verification, not
      // a frozen "Upload".
      setContributionPhase("verifying");
      setContributionProgress(92);

      const receipt = await submitContribution({
        circuitId,
        contributionHash: result.contributionHash,
        blobUrl,
        signal: controller.signal,
      });
      if (receipt.contributionHash.toLowerCase() !== result.zkeyHash.toLowerCase()) {
        throw new Error(
          "Receipt hash mismatch: the coordinator stored a different zkey than the client uploaded.",
        );
      }

      // Attach the contributor's own h_k for the attestation (client-computed,
      // not the server's serverContributionHash).
      return { ...receipt, clientHk: result.contributionHash };
    },
    onSuccess: (receipt) => {
      const circuitId = receipt.circuitId;

      // Fold this circuit's real elapsed time + constraint weight into the
      // running totals that drive the ETA.
      if (circuitComputeStartRef.current !== null) {
        measuredComputeMsRef.current += Date.now() - circuitComputeStartRef.current;
        measuredWeightRef.current += weightById.get(circuitId) ?? 0;
        circuitComputeStartRef.current = null;
      }

      clearAutoRetry();
      setReceipts((prev) => [...prev, receipt]);
      setContributionProgress(100);
      markCircuitStatus(circuitId, "done");

      if (currentCircuitIndex < activeCircuitIds.length - 1) {
        setCurrentCircuitIndex((value) => value + 1);
      } else {
        entropySeed?.fill(0);
        setFinalizeReady(true);
      }
    },
    onError: (error) => {
      if (error.name === "AbortError") return;
      const message = error instanceof Error ? error.message : String(error);
      // A 429 means our per-participant verify slot is still held (commonly a
      // prior attempt that died before releasing it). Wait the lock out instead
      // of spending the instant-retry budget bouncing off it (see waitThenRetry).
      if (error instanceof ApiError && error.status === 429) {
        waitThenRetry(message, error.retryAfterSeconds);
        return;
      }
      // Transient SERVER error (HTTP >=5xx) on the submit request: back off and
      // retry (bounded by MAX_SLOT_WAITS) rather than burning the instant-retry
      // budget and freezing on the manual Retry button. During the Upstash
      // outage the contribute route returned 500s and the 3-strike freeze
      // tripped the whole fleet at once with no recovery; this self-heals when
      // the backend comes back. Deliberately narrow to ApiError 5xx: the mutation
      // also throws plain Errors for TERMINAL failures (zkey/receipt hash
      // mismatch, worker failure, blob upload-token 4xx) and those — plus every
      // 4xx (bad proof, already contributed, not at front) — must still surface
      // via autoRetryOrSurface, not loop on recompute.
      if (error instanceof ApiError && error.status >= 500) {
        waitThenRetry(message, null);
        return;
      }
      autoRetryOrSurface(message, "contribution");
    },
  });

  // --- Rejoin mutation ---

  // Rejoin ONLY the current circuit (join-current-only): we hold exactly one
  // queue slot at a time, so a "not in queue" recovery must not re-add us to
  // every remaining circuit (that reintroduced the hold-all-slots problem).
  const rejoinMutation = useMutation({
    mutationFn: async () => {
      if (!currentCircuitId) return { positions: [] };
      return await joinQueue({ circuitIds: [currentCircuitId] });
    },
    onSuccess: (result) => {
      if (!currentCircuitId) return;
      const position = result.positions.find(
        (item) => item.circuitId === currentCircuitId,
      );
      setCircuitRuns((prev) =>
        prev.map((circuit) =>
          circuit.id === currentCircuitId && circuit.status !== "done"
            ? {
                ...circuit,
                status: "waiting" as const,
                position: position?.position,
                etaSeconds: position?.estimatedWaitSeconds,
              }
            : circuit,
        ),
      );
      setQueueError(null);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      setQueueError(message);
    },
  });

  // --- Queue position query (auto-polling) ---

  // Once a contribution/queue error is surfaced with the manual Retry/Cancel
  // buttons, the flow is paused waiting on the user. Stop polling AND stop the
  // heartbeat while blocked — otherwise the heartbeat would keep the front-of-
  // queue slot fresh forever, holding the line hostage instead of letting the
  // 300s queue timeout release it. `retry()` clears these errors and resumes.
  const blockedOnManualError = Boolean(contributionError || queueError);

  const queueEnabled =
    flowActive &&
    !!currentCircuitId &&
    !contributeMutation.isPending &&
    !finalizeReady &&
    !blockedOnManualError;
  const queuePositionQueryKey = [
    "queuePosition",
    flowRunId,
    currentCircuitId,
  ] as const;

  const queueQuery = useQuery({
    queryKey: queuePositionQueryKey,
    queryFn: ({ signal }) =>
      getQueuePosition({
        circuitId: currentCircuitId!,
        signal,
      }),
    refetchInterval: 6_000,
    enabled: queueEnabled,
    retry: false,
  });

  // Restart the current circuit from the queue: clear the error, mark the
  // circuit waiting and reset the queue query so polling re-triggers the
  // contribution. Shared by the automatic retry and the manual Retry button.
  const restartCurrentCircuit = () => {
    if (currentCircuitId) {
      markCircuitStatus(currentCircuitId, "waiting");
    }
    setContributionError(null);
    setQueueError(null);
    contributeMutation.reset();
    queryClient.resetQueries({ queryKey: queuePositionQueryKey });
  };

  // On failure, instantly retry up to MAX_ATTEMPTS times, showing the attempt
  // count in the error box. Once attempts are exhausted, surface the error with
  // the manual Retry/Cancel buttons (the previous behaviour).
  const autoRetryOrSurface = (
    message: string,
    surface: "contribution" | "queue",
  ) => {
    attemptsRef.current += 1;
    if (attemptsRef.current < MAX_ATTEMPTS) {
      setAutoRetrying(true);
      setAutoRetryMessage(message);
      setAutoRetryAttempt(attemptsRef.current + 1);
      restartCurrentCircuit();
      return;
    }

    setAutoRetrying(false);
    setAutoRetryMessage(null);
    setAutoRetryAttempt(0);
    if (surface === "contribution") {
      setContributionError(message);
      if (currentCircuitId) {
        markCircuitStatus(currentCircuitId, "error");
      }
    } else {
      setQueueError(message);
    }
  };

  // A 429 from the contribute submit: our verify slot is still held. Wait it out
  // (honouring Retry-After, clamped to a sane window) and then restart the
  // circuit, WITHOUT consuming a MAX_ATTEMPTS slot — so a lingering lock from a
  // crashed prior attempt self-heals instead of hard-failing the contribution.
  // Bounded by MAX_SLOT_WAITS so a slot that never clears still surfaces.
  const waitThenRetry = (
    message: string,
    retryAfterSeconds: number | null,
  ) => {
    if (slotWaitsRef.current >= MAX_SLOT_WAITS) {
      autoRetryOrSurface(message, "contribution");
      return;
    }
    slotWaitsRef.current += 1;
    const waitSeconds = Math.min(
      Math.max(retryAfterSeconds ?? SLOT_WAIT_MIN_SECONDS, SLOT_WAIT_MIN_SECONDS),
      SLOT_WAIT_MAX_SECONDS,
    );
    setAutoRetrying(true);
    setAutoRetryMessage(message);
    // Keep the existing "attempt X of Y" indicator coherent without spending the
    // hard budget: attemptsRef is untouched, so X stays within Y.
    setAutoRetryAttempt(attemptsRef.current + 1);
    if (slotWaitTimerRef.current !== null) {
      clearTimeout(slotWaitTimerRef.current);
    }
    slotWaitTimerRef.current = setTimeout(() => {
      slotWaitTimerRef.current = null;
      restartCurrentCircuit();
    }, waitSeconds * 1000);
  };

  // Update circuit run with latest queue position
  useEffect(() => {
    if (!queueQuery.data || !currentCircuitId) return;
    updateCircuitRun(currentCircuitId, {
      position: queueQuery.data.position,
      etaSeconds: queueQuery.data.estimatedWaitSeconds,
    });
    setQueueError(null);
    // A successful poll that leaves us waiting in line (position > 1) means a
    // transient queue error recovered, so drop the auto-retry indicator and the
    // attempt counter. At position 1 the contribution is about to (re)run, so
    // keep the indicator until that attempt resolves (onSuccess / onError).
    if (queueQuery.data.position !== 1) {
      clearAutoRetry();
    }
  }, [queueQuery.data, currentCircuitId, updateCircuitRun, clearAutoRetry]);

  // Trigger contribution when at position 1.
  // isPending is intentionally omitted from deps: including it would cause
  // infinite retries on failure (isPending true→false re-fires the effect
  // while position is still 1). On success, currentCircuitId advances.
  useEffect(() => {
    if (
      queueQuery.data?.position === 1 &&
      !contributeMutation.isPending &&
      currentCircuitId &&
      !finalizeReady
    ) {
      contributeMutation.mutate(currentCircuitId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueQuery.data?.position, currentCircuitId, finalizeReady]);

  // Handle "not in queue" errors by rejoining.
  // isPending is intentionally omitted: including it would cause infinite
  // rejoin attempts when the rejoin itself fails with the error still present.
  useEffect(() => {
    const msg = queueQuery.error?.message ?? "";
    if (
      msg.toLowerCase().includes("not in queue") &&
      !finalizeReady &&
      !rejoinMutation.isPending
    ) {
      rejoinMutation.mutate();
    } else if (queueQuery.error && !msg.toLowerCase().includes("not in queue")) {
      // Transient backend blip (network error or 5xx): do NOT surface a manual
      // error or spend the retry budget. The position poll (every 3s) and the
      // heartbeat keep running and self-heal the moment the backend recovers.
      // Surfacing here is what froze every client at once during the Upstash
      // outage — a shared blip tripped all of them into the manual-Retry state
      // simultaneously, so nothing self-recovered. Staying in the poll is safe
      // because the server-side active-slot cap bounds how long we can hold the
      // front even while we keep heartbeating. Only genuinely terminal (4xx)
      // errors go through the surface path.
      const status =
        queueQuery.error instanceof ApiError
          ? queueQuery.error.status
          : undefined;
      const transient = status === undefined || status >= 500;
      if (!transient) {
        autoRetryOrSurface(msg, "queue");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueQuery.error, finalizeReady]);

  // Join the current circuit's queue when it becomes current, and keep its slot
  // alive on an interval until we advance. This does double duty:
  //   1. join-current-only — we only ever hold ONE queue slot; the next circuit
  //      is joined here as it becomes current (not all up front), so a slow
  //      compute on one circuit can't age out our slots in the others.
  //   2. keep-alive heartbeat — re-POSTing bumps joinedAt, so a wait or a
  //      compute longer than queueTimeoutSeconds never silently drops our turn
  //      (which would otherwise force a stale-head recompute).
  // The POST also runs during compute (the position poll is paused then), which
  // is exactly when the slot would otherwise expire. Best-effort: a failed beat
  // is recovered by the poll's "not in queue" → rejoin path.
  useEffect(() => {
    if (!flowActive || !currentCircuitId || finalizeReady || blockedOnManualError)
      return;
    let cancelled = false;
    const beat = () => {
      joinQueue({ circuitIds: [currentCircuitId] }).catch(() => {
        /* best-effort; poll/rejoin recovers a dropped slot */
      });
    };
    beat();
    const timer = setInterval(() => {
      if (!cancelled) beat();
    }, QUEUE_HEARTBEAT_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [flowActive, currentCircuitId, finalizeReady, blockedOnManualError]);

  // Fast claim ping. Once we reach the FRONT (or are actively contributing), POST
  // /queue every ~10s — but only CLAIM_MAX_PINGS times — so the server latches
  // our claim well inside its claim window and does not skip us as a no-show. The
  // 90s heartbeat above is too slow for that window; a closed tab sends none of
  // these and is skipped. Bounded so a long compute isn't flooded with POSTs
  // (once latched, further pings are redundant — the active-slot cap governs).
  useEffect(() => {
    const atFront =
      queueQuery.data?.position === 1 || contributeMutation.isPending;
    // Fresh entry into the front (including after being rotated to the back and
    // cycling around, or moving to a new circuit) starts a new front turn, so
    // refill the ping budget. Must run before the budget guard below.
    if (atFront && !atFrontRef.current) {
      claimPingsRef.current = 0;
    }
    atFrontRef.current = atFront;
    if (
      !flowActive ||
      !currentCircuitId ||
      finalizeReady ||
      blockedOnManualError ||
      !atFront ||
      claimPingsRef.current >= CLAIM_MAX_PINGS
    ) {
      return;
    }
    let cancelled = false;
    const claim = () => {
      if (cancelled || claimPingsRef.current >= CLAIM_MAX_PINGS) return;
      claimPingsRef.current += 1;
      joinQueue({ circuitIds: [currentCircuitId] }).catch(() => {
        /* best-effort; the heartbeat and later POSTs also latch the claim */
      });
    };
    claim();
    const timer = setInterval(() => {
      if (cancelled || claimPingsRef.current >= CLAIM_MAX_PINGS) {
        clearInterval(timer);
        return;
      }
      claim();
    }, CLAIM_PING_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    queueQuery.data?.position,
    contributeMutation.isPending,
    flowActive,
    currentCircuitId,
    finalizeReady,
    blockedOnManualError,
  ]);

  // --- Actions (same public API) ---

  const joinAndStart = async (
    joinOptions: JoinOptions,
    allCircuits: ClientCircuitConfig[],
  ) => {
    setCircuitRuns([]);
    setResolvedCircuitIds([]);
    setQueueError(null);
    setCurrentCircuitIndex(0);
    setFinalizeReady(false);
    setContributionPhase("downloading");
    setContributionProgress(0);
    setContributionError(null);
    setReceipts([]);
    clearAutoRetry();
    resetEtaTracking();
    contributeMutation.reset();
    queryClient.removeQueries({ queryKey: ["queuePosition"] });
    setFlowRunId((value) => value + 1);

    // Resolve the ordered list of circuits to contribute to WITHOUT joining every
    // queue up front. Joining all at once made a participant hold a front-of-queue
    // slot in circuits they weren't working yet; those slots aged out while they
    // computed the first circuit, so the upfront positions went stale and
    // participants appeared to jump each other ("bad order"). We join only the
    // current circuit (here, and each next one via the heartbeat effect).
    let resolved: string[];
    try {
      const eligibility = await getParticipantEligibility();
      const eligibleSet = new Set(eligibility.eligibleCircuitIds);
      const selectedIds = joinOptions.circuitIds ?? selectedCircuitIds;
      resolved = selectedIds.filter((id) => eligibleSet.has(id));
      // Mirror the server's queue fallback: if everything in the selection is
      // already done but other circuits remain eligible, contribute to those.
      // (Tier resolution here is a simplified intersection and does NOT replicate
      // the server's per-tier backfill — acceptable while tiersEnabled is false;
      // the server continuity gate preserves chain integrity regardless.)
      if (resolved.length === 0) {
        resolved = eligibility.eligibleCircuitIds;
      }
    } catch {
      // Eligibility unavailable — fall back to the raw selection; the server
      // still enforces eligibility on submit, so this only affects ordering.
      resolved = joinOptions.circuitIds ?? selectedCircuitIds;
    }

    if (resolved.length === 0) {
      setQueueError("You have already contributed to every available circuit.");
      return;
    }

    // Render all resolved circuits as "waiting"; only the current one carries a
    // live queue position. The others are joined as they become current, so they
    // have no position yet.
    const makeRuns = (ids: string[]): CircuitRunItem[] =>
      ids.map((circuitId) => {
        const circuit = allCircuits.find((item) => item.id === circuitId);
        return {
          id: circuitId,
          label: circuit?.label ?? circuitId,
          status: "waiting" as const,
        };
      });

    // Join only the first circuit for an immediate position. The heartbeat effect
    // also (re)joins it, so a failure here is non-fatal — the poll recovers it.
    try {
      const result = await joinQueue({ circuitIds: [resolved[0]] });
      // The server is authoritative about which circuit it actually queued us on:
      // if resolved[0] went ineligible between our eligibility read and this join,
      // it falls back to a different eligible circuit. Follow it — make that the
      // current circuit — so the poll/heartbeat don't target a circuit we're not
      // actually queued on.
      const got = result.positions[0];
      if (got && got.circuitId !== resolved[0]) {
        resolved = [got.circuitId, ...resolved.filter((id) => id !== got.circuitId)];
      }
      setResolvedCircuitIds(resolved);
      const runs = makeRuns(resolved);
      if (got) {
        const idx = runs.findIndex((r) => r.id === got.circuitId);
        if (idx >= 0) {
          runs[idx] = {
            ...runs[idx],
            position: got.position,
            etaSeconds: got.estimatedWaitSeconds,
          };
        }
      }
      setCircuitRuns(runs);
    } catch {
      // Non-fatal: commit the resolved list so the flow can start; the heartbeat
      // effect + poll will join the current circuit and surface its position.
      setResolvedCircuitIds(resolved);
      setCircuitRuns(makeRuns(resolved));
    }
  };

  // Manual retry from the error box. Resets the attempt counter so the
  // automatic-retry cycle starts fresh, then restarts the current circuit.
  const retry = () => {
    clearAutoRetry();
    restartCurrentCircuit();
  };

  const cancel = () => {
    entropySeed?.fill(0);
    contributionAbortRef.current?.abort();
    contributeMutation.reset();
    resetState();
  };

  const resetState = () => {
    setCircuitRuns([]);
    setResolvedCircuitIds([]);
    setQueueError(null);
    setCurrentCircuitIndex(0);
    setFlowRunId((value) => value + 1);
    setFinalizeReady(false);
    setContributionPhase("downloading");
    setContributionProgress(0);
    setContributionError(null);
    setReceipts([]);
    clearAutoRetry();
    resetEtaTracking();
    contributeMutation.reset();
    queryClient.removeQueries({ queryKey: ["queuePosition"] });
  };

  // Live ETA: remaining constraint weight ÷ measured throughput. The active
  // circuit counts only its not-yet-done fraction (via contributionProgress) so
  // the estimate ticks down smoothly. Null until at least one circuit has
  // finished (no rate to extrapolate from yet) — the UI shows "estimating".
  const ratePerMs =
    measuredComputeMsRef.current > 0
      ? measuredWeightRef.current / measuredComputeMsRef.current
      : 0;
  let remainingWeight = 0;
  for (const run of circuitRuns) {
    if (run.status === "done") continue;
    const weight = weightById.get(run.id) ?? 0;
    if (run.status === "active") {
      const fraction = Math.min(Math.max(contributionProgress, 0), 100) / 100;
      remainingWeight += weight * (1 - fraction);
    } else {
      remainingWeight += weight;
    }
  }
  const estimatedSecondsRemaining =
    ratePerMs > 0 && circuitRuns.length > 0 && !finalizeReady
      ? Math.max(0, remainingWeight / ratePerMs / 1000)
      : null;

  return {
    circuitRuns,
    currentCircuitIndex,
    currentCircuitId,
    currentCircuit,
    estimatedSecondsRemaining,
    contributionPhase,
    contributionProgress,
    contributionError,
    queueError,
    finalizeReady,
    receipts,
    autoRetrying,
    autoRetryMessage,
    autoRetryAttempt,
    autoRetryMax: MAX_ATTEMPTS,
    joinAndStart,
    retry,
    cancel,
    reset: resetState,
  };
}
