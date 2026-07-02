# ppv2-tsc-test

Interactive UI for a Groth16 Phase 2 trusted setup ceremony. Participants contribute randomness through the browser while the app manages queue coordination, zkey storage, and receipt generation.

## Setup

### 1. Install

```bash
npm install
```

### 2. Add circuit files and download the ptau

Place your compiled `.r1cs` files in the `circuits/` folder, then run:

```bash
npm run setup:ptau
```

This reads each circuit's constraint count, downloads the correct [PPoT](https://github.com/privacy-ethereum/perpetualpowersoftau) `.ptau` file, and updates `ceremony.config.ts` with the actual constraint values.

> **Note:** If the circuit artifacts path was skipped in the wizard and circuits are being added now, `ceremony.config.ts` will have empty `circuits` and `tiers` arrays. These must be populated manually — see the [Configuration](#configuration) section below for the expected shape and examples.

### 3. Configure environment variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable                | Source              | Purpose                           |
| ----------------------- | ------------------- | --------------------------------- |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob         | Read/write zkey files             |
| `KV_REST_API_URL`       | Vercel KV (Upstash) | Redis endpoint for ceremony state |
| `KV_REST_API_TOKEN`     | Vercel KV (Upstash) | Redis auth token                  |
| `GITHUB_CLIENT_ID`      | GitHub OAuth App    | OAuth client ID                   |
| `GITHUB_CLIENT_SECRET`  | GitHub OAuth App    | OAuth client secret               |
| `NEXTAUTH_SECRET`       | Generated locally   | JWT session encryption secret     |
| `NEXTAUTH_URL`          | Deployment URL      | Canonical app URL                 |

### 4. Provision Vercel storage

1. Link to a Vercel project: `vercel link`
2. Create a **Blob** store in the Vercel dashboard (Storage tab).
3. Create a **KV (Upstash)** store in the same tab.
4. Pull the generated env vars: `vercel env pull`

### 5. GitHub OAuth

1. Create an OAuth App at [github.com/settings/developers](https://github.com/settings/developers).
2. Set the callback URL to `<your-url>/api/auth/callback/github`.
3. Check **Enable Device Flow** to support CLI contributions (`@wonderland/cabure-cli`).
4. Copy the Client ID and Client Secret into your `.env`.
5. Generate `NEXTAUTH_SECRET`:

```bash
openssl rand -base64 32
```

### 6. Initialize and run

```bash
npm run init:ceremony
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Deploy

```bash
vercel --prod
```

Add all environment variables in the Vercel dashboard under **Settings > Environment Variables**. Set `NEXTAUTH_URL` to your production domain.

The init script only needs to run once. After deploying, the API routes handle ceremony state automatically.

### Keep Vercel Fluid Compute OFF

The contribution route downloads the Powers of Tau file (large — often hundreds of MB) and runs `verifyChain` inside the request, writing temp files to `/tmp` (512 MB hard cap on Vercel).

**Turn Fluid Compute off** (Project → Settings → Functions). Fluid reuses instances and shares `/tmp` and memory across concurrent invocations, so two contributions verifying at the same time overflow `/tmp` (two copies of the ptau exceed 512 MB) and fail with:

> Verification failed. If your contribution is valid, please retry.

even though the contribution is valid. With Fluid off, each verify runs in its own isolated instance and fits.

Trade-off: classic functions cap `maxDuration` at 300 s (the contribute route sets exactly that). A circuit whose verify cannot finish under 300 s must be verified on an external worker rather than in the route.

## Scripts

| Script                      | Description                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `npm run setup:ptau`        | Detect circuit constraints, download the correct PPoT ptau, and update config             |
| `npm run init:ceremony`     | Generate genesis zkey, upload to Blob, write manifest to KV. Outputs to `public/genesis/` |
| `npm run reset:ceremony`    | Back up state, then wipe all KV keys and Blob objects (chain + pending uploads). Refuses a finalized ceremony unless `-- --force`; asks for typed confirmation unless `-- --yes` |
| `npm run finalize:ceremony` | Apply beacon (Ethereum RANDAO by default), verify zkeys. Outputs to `public/finalize/`    |

### Setup ptau

```bash
npm run setup:ptau             # download and update constraints
npm run setup:ptau -- --force  # re-download even if ptau exists
npm run setup:ptau -- --verify # also run snarkjs ptau verification
```

### Finalization

By default, finalization uses the RANDAO reveal from the latest finalized Ethereum beacon chain slot as the beacon source. This makes the beacon publicly verifiable.

```bash
npm run finalize:ceremony                              # latest finalized slot RANDAO (default)
npm run finalize:ceremony -- --beacon-slot 7325000     # specific pre-announced slot
npm run finalize:ceremony -- --beacon 0xabc123         # explicit hex beacon value
npm run finalize:ceremony -- --random-beacon           # random beacon (local testing only)
npm run finalize:ceremony -- --force                   # finalize before target is reached
```

For maximum verifiability, announce a future beacon chain slot number publicly before running with `--beacon-slot`. The RANDAO reveal is fetched from the Ethereum Beacon API (`BEACON_API_URL` env var overrides the default public endpoint).

Finalization seals the ceremony the moment it starts and commits the beacon at the same time. If a run is interrupted, the ceremony stays sealed: resume with `npm run finalize:ceremony -- --force`, which reuses the committed beacon so the result is reproducible, or run `npm run reset:ceremony` to start over. The beacon cannot be silently re-rolled by re-running.

### Initialization output

Running `init:ceremony` generates `public/genesis/`:

- `init-transcript.json` — full initialization record (ceremony config, circuit hashes, storage paths)
- `{circuitId}.genesis.zkey` — local copy of each genesis zkey

### Pin the genesis hash externally

`init:ceremony` records each circuit's genesis hash — as `genesisZkeyHash` in
`init-transcript.json` and as `initialZkeyHash` in KV. `finalize:ceremony` checks
the genesis blob against that hash before
verifying the chain, which catches a swapped or corrupted genesis blob while KV
is intact.

It does NOT defend against an attacker who can write both the blob and KV: they
rewrite the pinned hash to match the swapped genesis. To close that gap, publish
each `genesisZkeyHash` somewhere outside this deployment's control at the start
of the ceremony — commit it to a public Git repo, post it where contributors can
read it. Contributors and auditors can then confirm the finalized parameters
were built on the genesis announced at the start, not one substituted later.

### Finalization output

Running `finalize:ceremony` generates `public/finalize/`:

- `transcript.json` — full ceremony record (includes beacon source and slot)
- `{circuitId}.vkey.json` — Groth16 verification key
- `{circuitId}.final.zkey` — finalized proving key

## Contributor attestation (optional)

After contributing, the Complete screen has a **Publish as Gist** button that
posts an attestation to a public GitHub Gist on your own account in one click,
using your GitHub login (the app requests the `gist` scope at sign-in). The CLI
prints the same payload for you to publish manually. The attestation is a
timestamped, public record that your contribution happened — it includes your
contribution hash (`h_k`), its predecessor, and the chain hash.

Publishing is voluntary, and it is **not** a signature. It proves **inclusion**
(your `h_k` is recorded), not honesty, diversity, or sole authorship. Because
every `h_k` is public, anyone can publish a valid-looking attestation for
someone else's contribution, so a count of "N attestations" is **not** evidence
of N independent honest participants.

## Configuration

Edit `ceremony.config.ts` to customize the ceremony name, circuits, tiers, contribution targets, and UI copy. The full shape is defined by `CeremonyConfig` in `src/types/ceremony.ts`.

### Circuits

Each entry in `circuits` describes one zkey chain that contributors will extend. `setup:ptau` populates `constraints` automatically once the `.r1cs` files are in place.

```ts
circuits: [
  {
    id: "multiplier",                       // unique, stable ID used in receipts and storage paths
    label: "Multiplier",                    // display name in the UI
    description: "2-input multiplier proof",
    constraints: "1024",                    // filled in by `npm run setup:ptau`
    targetContributions: 100,               // per-circuit target; overrides the top-level value
    artifacts: {
      r1csPath: "circuits/multiplier.r1cs", // path relative to the project root
      ptauPath: PTAU_PATH,                  // points to circuits/pot_final.ptau, downloaded by `setup:ptau`
    },
  },
],
```

### Tiers

Tiers group circuits so contributors can pick a smaller commitment on the tier selection screen. Set `tiersEnabled: false` and omit `tiers` to skip the tier screen entirely and contribute to every circuit. `circuitIds` must reference IDs defined in `circuits`.

```ts
tiersEnabled: true,
tiers: [
  {
    id: "core",                                     // must be one of: "core" | "popular" | "all"
    label: "Core circuits",
    description: "Fast contribution — essential circuits only",
    estimatedMinutes: 5,
    circuitIds: ["multiplier"],
  },
  {
    id: "all",
    label: "Full ceremony",
    description: "Contribute to every circuit",
    estimatedMinutes: 30,
    circuitIds: ["multiplier"],             // add more IDs here after defining matching circuits above
  },
],
```
