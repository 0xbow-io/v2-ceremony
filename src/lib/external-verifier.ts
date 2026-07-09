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
  zkeyUrl: string;
  // Load-bearing: sha256 of the exact bytes the route will commit. The worker
  // MUST refuse to verify any zkey whose bytes don't hash to this, so it can
  // never return a valid verdict for bytes other than the committed ones.
  zkeySha256: string;
}

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

// Returns the worker's boolean verdict for a valid HTTP 200 {valid} response.
// Throws on any failure to obtain a verdict (non-200, malformed body, timeout,
// network error, token-minting failure) so the route's existing catch maps it
// to a non-consuming 503, exactly like an in-process verifier crash.
export async function verifyRemote(req: VerifyRemoteRequest): Promise<boolean> {
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
      zkeySha256: req.zkeySha256,
    }),
    signal: AbortSignal.timeout(REMOTE_VERIFY_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`verifier returned HTTP ${response.status}`);
  }

  const data = (await response.json()) as { valid?: unknown };
  if (typeof data.valid !== "boolean") {
    throw new Error("verifier returned a malformed response (no boolean valid)");
  }
  return data.valid;
}
