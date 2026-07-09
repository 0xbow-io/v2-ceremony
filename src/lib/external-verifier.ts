import { getVercelOidcToken } from "@vercel/functions/oidc";
import { ExternalAccountClient, Impersonated } from "google-auth-library";

// Optional offload of the heavy contribution verify (ptau download + snarkjs
// pairings) to an external worker (Cloud Run). Enabled purely by env: when
// CEREMONY_VERIFIER_URL is set, the contribute route calls verifyRemote instead
// of running verifyChain in-process. Unset = in-process verify (instant
// rollback). None of these vars are in env.ts REQUIRED_SERVER_VARS on purpose:
// their absence must be a valid, working configuration.
//
// Two auth layers to the worker, both applied when configured:
//   1. Cloud Run IAM — a Google OIDC ID token (audience = the service URL),
//      minted by federating Vercel's per-deployment OIDC token to a GCP service
//      account via Workload Identity Federation. This is the real authenticator.
//   2. x-verifier-token — a shared secret, defense-in-depth against the service
//      ever being made public by mistake. See verifier/README.md.

export interface VerifyRemoteRequest {
  url: string;
  token: string | undefined;
  // All three are server-derived public Blob URLs; the worker re-fetches them.
  ptauUrl: string;
  genesisUrl: string;
  genesisSha256: string;
  // The coordinator-owned committed copy (already promoted via a server-side blob
  // copy). The client cannot overwrite it, so the bytes the worker verifies are
  // exactly the bytes that will be committed — no per-attempt hash pin needed.
  zkeyUrl: string;
  // Continuity anchors from the coordinator's current head. They let the worker
  // reject a non-extending contribution BEFORE the expensive pairings (a cheap
  // parse + comparison), instead of verifying it only for the route to reject it
  // under the lock. The front-of-queue slot can't advance under the submitter, so
  // these are stable for the request; the route still re-checks them
  // authoritatively under the lock.
  expectedCount: number; // headCount + 1; also bounds the MPC parse.
  expectedCsHash: string; // circuit identity (csHash), constant across the chain.
  expectedLinkHash: string | null; // head this must build on; null at genesis.
}

// The worker's verdict plus the MPC view it read from the committed zkey, so the
// route can run the continuity gate and record the receipt without ever loading
// the bytes itself. A discriminated union: the metadata exists ONLY on the valid
// branch, so a caller cannot read a hash without first narrowing on `valid`.
export type RemoteVerifyResult =
  | {
      valid: false;
      // true  -> DEFINITIVE participant fault (unparseable / non-extending),
      //          decided before pairings: the route consumes the turn.
      // false -> verifyChain returned false (ambiguous infra-vs-invalid): the
      //          route keeps the turn and lets the client retry.
      rejected: boolean;
    }
  | {
      valid: true;
      zkeySha256: string;
      csHash: string;
      count: number;
      // h_k of the last (new-head) contribution; null only for an empty chain.
      headHash: string | null;
      // h_{k-1}: hash of the entry at count-2; null when count < 2.
      linkHash: string | null;
    };

// Under the 300s function budget after the route has already spent time on the
// blob fetch + parse; keep this safely below it so the platform never kills the
// request mid-call (which would strand the verify slot for its full TTL).
const REMOTE_VERIFY_TIMEOUT_MS = 200_000;

// Built once per warm instance. Federates the Vercel OIDC token to the invoker
// service account and mints Cloud Run ID tokens on demand. Null when the WIF env
// vars are not all set (e.g. dev, or a shared-secret-only deployment).
let impersonatedClient: Impersonated | null = null;

function getImpersonatedClient(): Impersonated | null {
  const projectNumber = process.env.GCP_PROJECT_NUMBER?.trim();
  const poolId = process.env.GCP_WORKLOAD_IDENTITY_POOL_ID?.trim();
  const providerId = process.env.GCP_WORKLOAD_IDENTITY_PROVIDER_ID?.trim();
  const invokerSa = process.env.GCP_INVOKER_SERVICE_ACCOUNT?.trim();
  if (!projectNumber || !poolId || !providerId || !invokerSa) return null;

  if (impersonatedClient) return impersonatedClient;

  const sourceClient = ExternalAccountClient.fromJSON({
    type: "external_account",
    audience: `//iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    subject_token_supplier: {
      getSubjectToken: () => getVercelOidcToken(),
    },
  });
  if (!sourceClient) {
    throw new Error("failed to build GCP external account client for OIDC");
  }

  impersonatedClient = new Impersonated({
    sourceClient,
    targetPrincipal: invokerSa,
    lifetime: 3600,
    delegates: [],
    targetScopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  return impersonatedClient;
}

// Returns the worker's verdict (and, when valid, the MPC view it read) for a
// valid HTTP 200 response. Throws on any failure to obtain a verdict (non-200,
// malformed body, timeout, network error, token-minting failure) so the route's
// existing catch maps it to a non-consuming 503, exactly like an in-process
// verifier crash.
export async function verifyRemote(
  req: VerifyRemoteRequest,
): Promise<RemoteVerifyResult> {
  const baseUrl = req.url.replace(/\/$/, "");

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (req.token) headers["x-verifier-token"] = req.token;

  const client = getImpersonatedClient();
  if (client) {
    // Audience must be the Cloud Run service URL for the IAM check to pass.
    const idToken = await client.fetchIdToken(baseUrl, { includeEmail: true });
    headers["authorization"] = `Bearer ${idToken}`;
  }

  const response = await fetch(`${baseUrl}/verify`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ptauUrl: req.ptauUrl,
      genesisUrl: req.genesisUrl,
      genesisSha256: req.genesisSha256,
      zkeyUrl: req.zkeyUrl,
      expectedCount: req.expectedCount,
      expectedCsHash: req.expectedCsHash,
      expectedLinkHash: req.expectedLinkHash,
    }),
    signal: AbortSignal.timeout(REMOTE_VERIFY_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`verifier returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data.valid !== "boolean") {
    throw new Error("verifier returned a malformed response (no boolean valid)");
  }
  if (!data.valid) {
    // rejected distinguishes a definitive participant fault (turn-consuming) from
    // a verifyChain=false verdict (non-consuming). Default to false (the safe,
    // non-consuming reading) if a caller/worker omits it.
    return { valid: false, rejected: data.rejected === true };
  }

  // valid === true: the MPC view the route needs for continuity + the receipt
  // MUST be present and well-typed, else we cannot commit — treat a malformed
  // success like an infra fault (throw → route 503) rather than committing junk.
  const { zkeySha256, csHash, count, headHash, linkHash } = data;
  if (
    typeof zkeySha256 !== "string" ||
    typeof csHash !== "string" ||
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    (headHash !== null && typeof headHash !== "string") ||
    (linkHash !== null && typeof linkHash !== "string")
  ) {
    throw new Error(
      "verifier returned a malformed valid response (missing MPC fields)",
    );
  }

  return {
    valid: true,
    zkeySha256,
    csHash,
    count,
    headHash: headHash ?? null,
    linkHash: linkHash ?? null,
  };
}
