export interface CircuitStatus {
  circuitId: string;
  targetContributions: number;
  totalContributions: number;
  currentParticipant: string | null;
  queueLength: number;
  latestContributionHash: string | null;
  chainHash: string;
  isComplete: boolean;
}

export interface StatusResponse {
  isActive: boolean;
  totalContributions: number;
  targetContributions: number;
  endDate: string | null;
  startedAt: number;
  beaconApplied: boolean;
  circuits: CircuitStatus[];
}

export type CircuitPreviewState =
  | "willRun"
  | "alreadyContributed"
  | "targetReached"
  | "fallback";

export interface TierPreview {
  tierId: string;
  items: Array<{ circuitId: string; state: CircuitPreviewState }>;
}

export interface ParticipantEligibilityResponse {
  participantId: string;
  contributedCircuitIds: string[];
  eligibleCircuitIds: string[];
  hasEligibleCircuits: boolean;
  tierPreviews: TierPreview[];
}

export interface QueuePosition {
  participantId: string;
  circuitId: string;
  position: number;
  estimatedWaitSeconds: number;
}

export interface ReceiptResponse {
  success: boolean;
  circuitId: string;
  participantId: string;
  contributionIndex: number;
  contributionHash: string;
  clientContributionHash: string | null;
  // Genuine contribution hash (h_k): the Blake2b that the chain folds over and
  // that the attestation publishes. The /receipt and /participant/receipts
  // routes already spread the stored receipt, so this value flows through.
  serverContributionHash: string;
  // h_{k-1}: predecessor hash for the attestation; null for the first.
  previousContributionHash: string | null;
  chainHash: string;
  timestamp: number;
}

export interface ZkeyInfo {
  url: string;
  contributionIndex: number;
  hash: string | null;
}

// Error that preserves the HTTP status and Retry-After so callers can react to
// specific responses (e.g. back off on a 429) instead of only seeing a message
// string. Extends Error, so existing `error.message` handling is unaffected.
export class ApiError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    status: number,
    retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

async function apiFetch<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, init);
  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok) {
    const body = contentType.includes("application/json")
      ? ((await response.json()) as { error?: string })
      : { error: await response.text() };
    const message =
      body.error || `Request failed with status ${response.status}.`;
    throw new ApiError(
      message,
      response.status,
      parseRetryAfter(response.headers.get("Retry-After")),
    );
  }

  if (contentType.includes("application/json")) {
    return (await response.json()) as T;
  }

  return (await response.text()) as T;
}

export async function getStatus(signal?: AbortSignal): Promise<StatusResponse> {
  return await apiFetch<StatusResponse>("/api/ceremony/status", { signal });
}

export async function getParticipantEligibility(
  signal?: AbortSignal,
): Promise<ParticipantEligibilityResponse> {
  return await apiFetch<ParticipantEligibilityResponse>(
    "/api/ceremony/participant/eligibility",
    { signal },
  );
}

export interface ParticipantReceiptsResponse {
  participantId: string;
  receipts: ReceiptResponse[];
}

export async function getMyReceipts(
  signal?: AbortSignal,
): Promise<ParticipantReceiptsResponse> {
  return await apiFetch<ParticipantReceiptsResponse>(
    "/api/ceremony/participant/receipts",
    { signal },
  );
}

export async function joinQueue(options: {
  tierId?: string;
  circuitIds?: string[];
  signal?: AbortSignal;
}): Promise<{ positions: QueuePosition[] }> {
  const payload: Record<string, unknown> = {};
  if (options.tierId) {
    payload.tierId = options.tierId;
  } else if (options.circuitIds) {
    payload.circuitIds = options.circuitIds;
  }
  return await apiFetch<{ positions: QueuePosition[] }>("/api/ceremony/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
}

export async function getQueuePosition(options: {
  circuitId: string;
  signal?: AbortSignal;
}): Promise<QueuePosition> {
  const params = new URLSearchParams({
    circuitId: options.circuitId,
  });
  return await apiFetch<QueuePosition>(
    `/api/ceremony/queue?${params.toString()}`,
    { signal: options.signal },
  );
}

export async function getZkeyInfo(
  circuitId: string,
  signal?: AbortSignal,
): Promise<ZkeyInfo> {
  return await apiFetch<ZkeyInfo>(
    `/api/ceremony/circuits/${circuitId}/zkey?format=json`,
    { signal },
  );
}

// Abort the upload if it makes no progress for this long. The blob PUT streams
// straight to storage with no built-in timeout, so a stalled connection would
// hang the contribution forever — and the progress UI has no Cancel while
// uploading. This is an IDLE timeout (reset on every progress event), not a
// total cap, so a legitimately slow large upload is fine; only a true stall
// trips it.
const UPLOAD_STALL_TIMEOUT_MS = 60_000;

export async function uploadZkey(options: {
  circuitId: string;
  payload: Uint8Array;
  signal?: AbortSignal;
}): Promise<string> {
  const { upload } = await import("@vercel/blob/client");

  // One controller drives the upload: it fires on the caller's cancel OR on the
  // stall timeout. Forwarding the caller's signal (instead of AbortSignal.any)
  // keeps this working on older browsers.
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const armStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), UPLOAD_STALL_TIMEOUT_MS);
  };

  try {
    armStallTimer();
    const blob = await upload(
      `contributions/${options.circuitId}/pending.zkey`,
      new Blob([options.payload as BlobPart]),
      {
        access: "public",
        handleUploadUrl: `/api/ceremony/circuits/${options.circuitId}/upload`,
        abortSignal: controller.signal,
        onUploadProgress: armStallTimer,
      },
    );
    return blob.url;
  } catch (error) {
    // Distinguish a stall from a deliberate cancel. A cancel is the caller's
    // signal and stays an AbortError (the contribution flow swallows it). A
    // stall is our timeout firing with no caller cancel — surface it as a real
    // error so the flow shows Retry instead of the silent cancel path.
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new Error("Upload stalled with no progress. Please retry.");
    }
    throw error;
  } finally {
    clearTimeout(stallTimer);
    // Drop the caller-signal listener. With { once: true } it self-removes only
    // after firing, so on the success path (no cancel) it would otherwise linger
    // on a long-lived signal and retain this controller. removeEventListener is a
    // no-op if it already fired.
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}

export async function submitContribution(options: {
  circuitId: string;
  contributionHash: string;
  blobUrl: string;
  signal?: AbortSignal;
}): Promise<ReceiptResponse> {
  return await apiFetch<ReceiptResponse>(
    `/api/ceremony/circuits/${options.circuitId}/contribute`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        blobUrl: options.blobUrl,
        contributionHash: options.contributionHash,
      }),
      signal: options.signal,
    },
  );
}

export async function getReceipt(options: {
  circuitId: string;
  participantId: string;
  contributionIndex: number;
  contributionHash?: string;
  signal?: AbortSignal;
}): Promise<ReceiptResponse> {
  const params = new URLSearchParams({
    circuitId: options.circuitId,
    participantId: options.participantId,
    contributionIndex: String(options.contributionIndex),
  });
  if (options.contributionHash) {
    params.set("contributionHash", options.contributionHash);
  }
  return await apiFetch<ReceiptResponse>(
    `/api/ceremony/receipt?${params.toString()}`,
    { signal: options.signal },
  );
}
