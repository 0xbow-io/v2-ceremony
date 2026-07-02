"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  ApiError,
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

  const activeCircuitIds =
    resolvedCircuitIds.length > 0 ? resolvedCircuitIds : selectedCircuitIds;
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
      autoRetryOrSurface(message, "contribution");
    },
  });

  // --- Rejoin mutation ---

  const rejoinMutation = useMutation({
    mutationFn: async () => {
      const remaining = activeCircuitIds.slice(currentCircuitIndex);
      return await joinQueue({
        circuitIds: remaining,
      });
    },
    onSuccess: (result) => {
      const remaining = activeCircuitIds.slice(currentCircuitIndex);
      setCircuitRuns((prev) =>
        prev.map((circuit) => {
          if (!remaining.includes(circuit.id) || circuit.status === "done") {
            return circuit;
          }
          const position = result.positions.find(
            (item) => item.circuitId === circuit.id,
          );
          return {
            ...circuit,
            status: "waiting" as const,
            position: position?.position,
            etaSeconds: position?.estimatedWaitSeconds,
          };
        }),
      );
      setQueueError(null);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      setQueueError(message);
    },
  });

  // --- Queue position query (auto-polling) ---

  const queueEnabled =
    flowActive &&
    !!currentCircuitId &&
    !contributeMutation.isPending &&
    !finalizeReady;
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
    refetchInterval: 3_000,
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
      autoRetryOrSurface(msg, "queue");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueQuery.error, finalizeReady]);

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
    contributeMutation.reset();
    queryClient.removeQueries({ queryKey: ["queuePosition"] });
    setFlowRunId((value) => value + 1);

    const result = await joinQueue(joinOptions);

    const ids = result.positions.map((p) => p.circuitId);
    setResolvedCircuitIds(ids);

    const runs: CircuitRunItem[] = ids.map((circuitId) => {
      const circuit = allCircuits.find((item) => item.id === circuitId);
      const position = result.positions.find(
        (item) => item.circuitId === circuitId,
      );
      return {
        id: circuitId,
        label: circuit?.label ?? circuitId,
        status: "waiting",
        position: position?.position,
        etaSeconds: position?.estimatedWaitSeconds,
      };
    });

    setCircuitRuns(runs);
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
    contributeMutation.reset();
    queryClient.removeQueries({ queryKey: ["queuePosition"] });
  };

  return {
    circuitRuns,
    currentCircuitIndex,
    currentCircuitId,
    currentCircuit,
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
