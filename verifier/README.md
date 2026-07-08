# ceremony-verifier

Standalone worker that runs the heavy contribution `verifyChain` (ptau download +
snarkjs pairings) off the Vercel function. When `CEREMONY_VERIFIER_URL` is set,
the contribute route calls this worker over HTTPS instead of verifying in-process;
unset it to fall back to in-process verify. See `src/lib/external-verifier.ts` and
the `mustVerify` block in
`src/app/api/ceremony/circuits/[id]/contribute/route.ts`.

The worker holds **no** ceremony state, KV, or Blob credentials — every input is a
public Blob URL. It needs only its own auth (below).

## Why

Under load / on the large circuits, the in-process verify spikes past the Vercel
function's memory + `/tmp` limits (it holds a ~288 MB ptau plus the genesis and
candidate zkey and writes them all to a 512 MB `/tmp`), causing OOM 500s. Moving
`verifyChain` to a dedicated container removes that pressure from the request; the
route just awaits a small HTTPS call.

## Status

**Deployed** to Cloud Run in the v2 GCP project — private (see Auth). The Vercel
production env vars are set. It is **not yet active**: the route change must be
deployed for the offload to take effect (this is the PR under review). GCP
resource identifiers live in internal ops notes, not this repo.

## Endpoint

`POST /verify` — auth required (see below).

```json
{
  "ptauUrl": "https://<...>.public.blob.vercel-storage.com/.../pot-<hash>.ptau",
  "genesisUrl": "https://<...>.public.blob.vercel-storage.com/.../genesis.zkey",
  "genesisSha256": "0x...",
  "zkeyUrl": "https://<...>.public.blob.vercel-storage.com/contributions/<id>/...",
  "zkeySha256": "0x..."
}
```

Responses:
- `200 {valid:true}` → route commits.
- `200 {valid:false}` → definitive invalid chain → route returns a non-consuming
  400 (participant keeps their queue turn).
- any non-2xx → the verify could not be *run* (bad/mismatched hash, download
  failure, crash) → route returns a non-consuming 503. An infra fault is never
  charged as an invalid contribution.

`zkeySha256` is a **load-bearing** pin: the worker refuses to verify any bytes
that don't hash to it, so it can only ever attest to the exact bytes the route
commits (closes the swap-between-fetches TOCTOU).

`GET /healthz` → `200 {ok:true}` for startup/liveness probes.

## Auth (two layers)

1. **Cloud Run IAM (the real authenticator).** The service is private. The Vercel
   route federates its per-deployment OIDC token to a dedicated invoker service
   account (Workload Identity Federation) and mints a Google ID token scoped to the
   service. The federation is locked to the ceremony's Vercel **production**
   deployment, so only it can invoke; unauthenticated calls are dropped at Google's
   edge and never reach the container. Preview/dev deployments cannot invoke (and
   don't have the env vars set), so they cleanly fall back to in-process verify.
2. **`x-verifier-token` shared secret (defense-in-depth).** Injected from a secret;
   the worker refuses to start without it. Guards against the service ever being
   flipped public by mistake.

Deploy rights to this service are ceremony-critical (a rogue image could return
`{valid:true}` for anything): keep GCP `run.admin` / registry-write limited to
named operators and pin the deployed image by digest.

## Enabling / disabling the offload

Controlled entirely by one env var on the Vercel project — no code change:

- **Enable:** set `CEREMONY_VERIFIER_URL` (already set in production) and deploy the
  route. Verifies then run on the worker.
- **Disable / roll back:** `vercel env rm CEREMONY_VERIFIER_URL production` and
  redeploy (~2 min) — the route falls straight back to the in-process verifier that
  remains in the code. Or use Vercel Instant Rollback to the prior deployment.

Note: verification itself is **mandatory** in production regardless
(`NODE_ENV === "production"`); this flag only chooses *where* it runs, never
whether it runs.

## Vercel environment variables (production)

| Variable | Purpose |
| --- | --- |
| `CEREMONY_VERIFIER_URL` | Worker base URL. Set = offload on; unset = in-process. |
| `CEREMONY_VERIFIER_TOKEN` | Shared secret; must equal the worker's `VERIFIER_TOKEN`. |
| `GCP_PROJECT_NUMBER` | For the OIDC/WIF token exchange. |
| `GCP_WORKLOAD_IDENTITY_POOL_ID` | WIF pool id. |
| `GCP_WORKLOAD_IDENTITY_PROVIDER_ID` | WIF provider id. |
| `GCP_INVOKER_SERVICE_ACCOUNT` | Invoker SA the route impersonates to mint the ID token. |

The four `GCP_*` vars enable the IAM layer; if they're absent the route still sends
the shared-secret header only (useful for a public-URL fallback or local testing).

## Prerequisites before enabling in production

1. **Fix the `deposit` ptau 404.** Its circuit `ptauUrl` in KV currently 404s;
   the worker fetches the same URL and would 503 too. Repair the KV state / re-run
   init before relying on the offload for that circuit (others are unaffected if
   their URLs resolve).
2. **Confirm OIDC is enabled** for the Vercel project (a `VERCEL_OIDC_TOKEN` pulls
   successfully, which indicates it is).
3. **Deploy the route change** (this PR).

## Infrastructure (provisioned in the v2 GCP project)

- Cloud Run service — private, gen2, `concurrency=1` (one verify per instance),
  request timeout well above the verify, one warm min-instance to keep the ptau
  cached, and a max-instances cap sized to worst-case concurrent circuits within
  the regional CPU quota.
- Artifact Registry image (`linux/amd64`, `npm ci` from the committed lockfile).
- A zero-role runtime service account (reads only its token secret).
- An invoker service account + Workload Identity Federation binding to the Vercel
  production deployment.

## Reproducible builds

`package.json` pins `@wonderland/cabure-crypto@2.0.0` and `snarkjs@0.7.5` (matching
the app) and commits `package-lock.json`, so the Dockerfile uses `npm ci --omit=dev`
— the worker's snarkjs is integrity-pinned to the exact build the ceremony's
security analysis assumes. The worker loads cabure-crypto's **CJS** build via
`createRequire` (its ESM bundle does a dynamic `require()` plain Node rejects; the
Next app only avoids this because webpack rewrites it).

## Smoke test (contribution-free)

The current head of any circuit is an already-verified chain — a perfect fixture.
POST a circuit's `ptauUrl` / `initialZkeyUrl` / `initialZkeyHash` (as
`genesisUrl`/`genesisSha256`) and `currentZkeyUrl` / `latestContributionHash` (as
`zkeyUrl`/`zkeySha256`) to `/verify`; expect `{valid:true}`, a wrong `zkeySha256`
→ 422, a wrong/absent token → 401/403. This exercises the full worker (fetch +
`verifyChain` + auth) without submitting a contribution.
