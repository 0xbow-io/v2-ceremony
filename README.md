# Privacy Pools V2: Trusted Setup Ceremony

A browser-based **Groth16 Phase-2 trusted setup ceremony** for the Privacy Pools V2
zero-knowledge circuits. Anyone can contribute fresh randomness from their browser;
the app coordinates the queue, stores the proving keys, verifies every contribution,
and, once finished, publishes everything you need to check the result yourself.

> **The one thing to remember about a trusted setup:** it is secure as long as **at
> least one** participant was honest and destroyed their secret randomness. You do not
> have to trust the organizers, the other contributors, or this website. You only
> have to trust *yourself*, or anyone else who contributed honestly. This document
> explains how to contribute, and how to verify the whole thing independently.

---

## Contents

- [What this is](#what-this-is)
- [How it works](#how-it-works)
- [The circuits](#the-circuits)
- [Contributing](#contributing)
- [Verifying the ceremony yourself](#verifying-the-ceremony-yourself) ← the important part
- [Published artifacts reference](#published-artifacts-reference)
- [Running your own deployment (operators)](#running-your-own-deployment-operators)
- [Configuration](#configuration)
- [Trust model & guarantees](#trust-model--guarantees)

---

## What this is

Privacy Pools V2 uses Groth16 zk-SNARKs. Groth16 needs a **circuit-specific
proving key** (a `.zkey`), and generating that key involves secret randomness (often
called *toxic waste*). If a single party generated the key alone and kept that
randomness, they could forge proofs, e.g. withdraw funds that were never deposited.

A **Phase-2 trusted setup ceremony** removes that risk by having many independent
people each fold their own secret randomness into the key, one after another, and then
destroy it. The final key is safe unless **every single** contributor colluded or was
compromised. One honest contributor is enough.

This app runs that ceremony for all **27 Privacy Pools V2 circuits** entirely in the
browser:

- **Your randomness never leaves your device.** The contribution is computed in a
  WebAssembly worker in your browser. Only the transformed proving key is uploaded.
  The secret is zeroed from memory immediately and never written to disk or sent to the
  coordinator.
- **Every contribution is verified** on the server before it is accepted, and the
  entire chain is re-verified from the original parameters at finalization.
- **The result is publicly checkable.** Finalization applies a public, unpredictable
  beacon (Ethereum beacon-chain randomness) and publishes a transcript, the
  verification keys, and the final proving keys so anyone can reproduce the checks.

---

## How it works

```
                    ┌─────────────────────────────────────────────┐
   Genesis zkey ───▶│  contribution 1 ▶ contribution 2 ▶ … ▶ N     │──▶ + Beacon ──▶ Final zkey
   (pinned, hash    │  (each contributor folds in secret entropy,   │   (public       (+ vkey,
    published)      │   server verifies, hash recorded in a chain)  │    Ethereum      transcript)
                    └─────────────────────────────────────────────┘    RANDAO)
```

1. **Genesis.** The operator runs the Phase-1 → Phase-2 transition once, producing a
   *genesis* `.zkey` per circuit from the circuit's `.r1cs` and a Perpetual Powers of
   Tau (`.ptau`) file. The genesis is hashed and that hash is **published externally**
   so it can never be swapped later.
2. **Contributions.** Each contributor downloads the current `.zkey`, verifies its
   hash, folds in randomness derived from their own device, and uploads the result. The
   server verifies the new key genuinely extends the chain and records the
   contribution's hash in a running **hash chain**.
3. **Finalization.** When the target is reached (or the deadline passes), the operator
   applies a **beacon**, by default the RANDAO reveal from a finalized Ethereum
   beacon-chain slot, which is public and was unpredictable in advance. Before doing so
   the server re-verifies the whole chain from the pinned genesis and re-walks it
   against the recorded hashes. It then exports each circuit's **verification key** and
   **final proving key**, plus a **transcript** of the entire ceremony.

---

## The circuits

The ceremony covers 27 circuits. Contributors contribute to every circuit in sequence
(largest circuits take the most time).

| Circuit | What it proves |
| --- | --- |
| `deposit` | Deposit funds into the privacy pool. |
| `ragequit` | Exit the pool and withdraw your full deposit. |
| `transact_NxM` (N,M ∈ 1..5) | A private transfer with **N** input notes and **M** output notes: 25 variants, from `transact_1x1` to `transact_5x5`. |

Larger `N×M` circuits have more constraints and take longer to contribute to. Exact
constraint counts are listed in [`ceremony.config.ts`](./ceremony.config.ts).

---

## Contributing

**Live ceremony:** https://ceremony.privacypools.com

### Requirements

- A **desktop browser** (the contribution runs a heavy WASM computation; mobile is not
  supported).
- A **GitHub account**: sign-in is required to prevent spam, enforce contribution
  eligibility, and give each participant a place in the queue. The coordinator keeps
  the account identifier in its access-control state and stored receipt, but public
  status, receipt lookup, downloaded receipts, and the final transcript do not publish
  it.
- **Time and a device that stays awake.** Contributing to all 27 circuits runs entirely
  in your browser and takes anywhere from ~15 minutes to well over an hour depending on
  your hardware and connection (see [How long it takes](#how-long-it-takes)). Keep the
  tab open and foregrounded until it finishes.

### What happens, step by step

1. **Sign in with GitHub** and join the queue.
2. **Collect entropy.** Move your mouse / tap around. Your input is mixed into
   cryptographic randomness that seeds your contribution.
3. **Contribute.** For each circuit the app downloads the current key, verifies its
   hash, computes your contribution in a background worker, uploads it, and waits for
   the server to verify it.
4. **Get your receipt.** When you finish, you receive a receipt for each circuit and
   can download it as JSON. Optionally, publish a one-click **attestation** (see below).

### How long it takes

Plan for it to take a while. **This is normal and expected.** For each of the 27
circuits your browser (1) downloads the current proving key, (2) computes your
contribution, and (3) uploads the result. The larger circuits (the `transact_5x5` end)
have bigger keys, so both the transfer and the computation grow. Total time is dominated
by your **CPU** (the compute) and your **connection speed** (the up/downloads).

| Machine | Connection | Approx. total time |
| --- | --- | --- |
| Apple M4 Max | ~1 Gbps | ~15 min |
| Recent laptop (e.g. M2/M3 Pro) | ~300 Mbps | ~35 min* |
| Apple M1 Max | ~100 Mbps | ~1 h 15 min |

<sub>*Interpolated. These are rough figures from limited early runs. Treat them as a
guide, not a guarantee. A slower CPU or connection simply takes longer; nothing is
wrong.</sub>

There is nothing to babysit: the app shows per-circuit progress and an updating time
estimate, and it automatically retries transient network hiccups. Just leave the tab
open (and your machine awake) and let it finish.

### What happens to your secret randomness

Your secret entropy is generated in memory, used to transform the keys, and then
**immediately zeroed**. It is never written to disk and never transmitted to the
coordinator. Only the resulting proving key (which reveals nothing about your secret)
is uploaded. This is the "toxic waste destroyed" step shown on the completion screen.

### Your receipt

Contributor-controlled receipt downloads contain only the fields below. They omit the
participant identifier and coordinator timestamp.

| Field | Meaning |
| --- | --- |
| `circuitId`, `contributionIndex` | Which circuit, and your position in its chain. |
| `serverContributionHash` | **Your contribution hash `h_k`**: the Blake2b hash that the ceremony chain folds over and that appears inside the final proving key. This is the value you look for when verifying that your contribution was included. |
| `contributionHash` | SHA-256 of the exact `.zkey` bytes you produced (a file integrity hash, distinct from `h_k`). |
| `previousContributionHash` | The head hash `h_{k-1}` your contribution extended. |
| `chainHash` | The running chain hash after your contribution: `SHA-256(previousChainHash ‖ h_k)`. |
| `clientContributionHash` | Your browser-computed `h_k`. Included only in your owner receipt, not the public lookup or final transcript. |

### Attestation (optional)

From the completion screen you can **Publish as Gist**, which posts a small public
record to a GitHub Gist on your own account, timestamped with your login. It contains
your circuit, index, and your own `h_k`.

An attestation is **not a signature and not a vote.** It only lets *you* later point to
a public, timestamped record that your contribution happened, useful for detecting if
your contribution were ever censored (your `h_k` would be absent from the final key).
Because every `h_k` is public, anyone could publish a valid-looking attestation for
someone else's contribution, so **a count of "N attestations" is not evidence of N
independent honest participants.** Security comes from the verifiable hash chain and
the open verifier below, not from attestations.

---

## Verifying the ceremony yourself

**You do not have to trust this website.** Everything needed to independently verify the
final parameters is published. This section is the runbook. All checks use
[`snarkjs`](https://github.com/iden3/snarkjs) (the standard, widely-audited tool),
so you never have to run code from this project to trust its output.

### What you need

1. **`snarkjs`**, pinned to the version this ceremony used:
   ```bash
   npm install -g snarkjs@0.7.5
   ```
2. **The published ceremony artifacts** (served from the ceremony site's web root):
   - `https://ceremony.privacypools.com/finalize/transcript.json`
   - `https://ceremony.privacypools.com/finalize/<circuit>.final.zkey`
   - `https://ceremony.privacypools.com/finalize/<circuit>.vkey.json`
   - `https://ceremony.privacypools.com/genesis/<circuit>.genesis.zkey`
   - `https://ceremony.privacypools.com/genesis/init-transcript.json`
3. **The circuit `.r1cs` files**, from the *audited* Privacy Pools V2 circuits release
   (compile them yourself from the audited sources for maximum assurance; do not take
   the r1cs from this app).
4. **The Powers of Tau (`.ptau`) file** the ceremony was built on. It uses the Privacy &
   Scaling Explorations [Perpetual Powers of Tau](https://github.com/privacy-scaling-explorations/perpetualpowersoftau)
   `pot28_0080` file, sized per circuit (`ppot_0080_<NN>.ptau`, where `<NN>` is the
   smallest power of two that fits the circuit's constraints). `setup:ptau` downloads it
   from the public PSE bucket; you can fetch the same file independently. Its provenance
   comes from the public PPoT ceremony, not from this deployment.

> The `.r1cs` and `.ptau` are the trust roots that come from *outside* this deployment.
> Getting them from the audited circuit release and the canonical PPoT, not from this
> app, is what makes the verification independent.

### Step 1: The genesis is the one that was announced

The whole chain is only meaningful if it started from the genuine genesis. Confirm the
genesis key matches the hash **published externally at the start of the ceremony**
(e.g. in a public Git commit or announcement), and that the same hash appears in
`init-transcript.json`:

```bash
sha256sum deposit.genesis.zkey
# 0x-strip and compare against:
#  - the externally announced genesis hash for `deposit`
#  - init-transcript.json → circuits[].genesisZkeyHash
```

If these disagree, stop: the chain was not rooted in the announced parameters.

### Step 2: Each final key is a valid Phase-2 key for its circuit

This is the core check. `snarkjs zkey verify` recomputes the entire Phase-2 chain from
the Powers of Tau through every contribution and the final beacon, and confirms the
final key is internally consistent:

```bash
snarkjs zkey verify deposit.r1cs powersOfTau_final.ptau deposit.final.zkey
# Expect: "ZKey Ok!"
```

It also prints the Blake2b hash of **every** contribution in the chain and the beacon.
Keep this output for Step 4. Repeat for all 27 circuits.

### Step 3: The beacon is public, unpredictable randomness

Finalization mixes in a beacon so that even if *every* contributor were malicious, the
final key still depends on a value nobody could control. By default the beacon is the
RANDAO reveal from a finalized Ethereum beacon-chain slot. Read it from the transcript:

```bash
jq '.ceremony | {beaconHash, beaconSource, beaconSlot}' transcript.json
```

Then fetch that slot's RANDAO reveal from any Ethereum beacon node and confirm it
matches `beaconHash`:

```bash
curl -s https://ethereum-beacon-api.publicnode.com/eth/v2/beacon/blocks/<beaconSlot> \
  | jq -r '.data.message.body.randao_reveal'
# strip the leading 0x and compare to transcript.json → ceremony.beaconHash
```

The same beacon value is embedded in each `*.final.zkey` and printed by the Step 2
`zkey verify` output, so you can confirm the published beacon is the one actually
applied. For the strongest guarantee, the operator announces the target slot number
*before* it is produced. Check that announcement against `beaconSlot`.

### Step 4: Your contribution is included

Find your own `h_k` (the `serverContributionHash` from your receipt, or the `h_k` in
your attestation Gist) in the list of contribution hashes printed by `zkey verify` in
Step 2, or in the transcript:

```bash
jq '.receipts[] | select(.circuitId=="deposit") | {contributionIndex, serverContributionHash}' transcript.json
```

Because Step 2 proved the chain is valid and Step 3 proved the final beacon is public
randomness, your `h_k` appearing in the verified chain means your randomness is
permanently part of the final key.

### Step 5: The verification key matches the final key (optional)

dApps embed the small `*.vkey.json`, not the large `.final.zkey`. Confirm the published
verification key is the one derived from the verified proving key:

```bash
snarkjs zkey export verificationkey deposit.final.zkey vkey_check.json
diff <(jq -S . vkey_check.json) <(jq -S . deposit.vkey.json)   # expect no differences
```

### Step 6: The recorded chain is self-consistent (optional)

You can independently recompute the chain hash from the receipts. Starting from
`chainHash₀ = 0x000…0` (32 zero bytes), for each contribution in order:

```
chainHashₖ = SHA-256( chainHashₖ₋₁  ‖  h_k )        # raw bytes, not text
```

The result after the last contribution must equal the circuit's `finalChainHash` in
`transcript.json`. This ties the published transcript to the same `h_k` values you
verified inside the final key. Transcript receipts contain the circuit, index,
contribution hashes, predecessor hash, and chain hash, but no participant identifier,
timestamp, or client hash.

### Quick check: verify a single receipt in the app

If you just want to confirm a receipt is recorded by the coordinator (a convenience
check, **not** a substitute for the independent verification above), use the **Verify**
screen on the ceremony site and paste the receipt JSON. It confirms the receipt's hash
matches the coordinator's record; it does not re-derive anything cryptographically.
Receipt checks require the circuit ID, contribution index, and contribution hash.

---

## Published artifacts reference

Finalization writes to `public/finalize/` (served at the site's web root):

| File | Contents |
| --- | --- |
| `transcript.json` | Public ceremony record: beacon (hash, source, slot), and per circuit the `totalContributions`, `finalChainHash`, `finalContributionHash` (the beacon's hash), `finalZkeyHash`, and `verificationKey`; plus identity-redacted public receipts for every contribution. |
| `<circuit>.vkey.json` | Groth16 verification key. Embed this in verifiers/dApps. |
| `<circuit>.final.zkey` | Finalized proving key. |

Initialization writes to `public/genesis/`:

| File | Contents |
| --- | --- |
| `init-transcript.json` | Genesis record: per circuit the `genesisZkeyHash`, `csHash` (circuit identity), sizes, and storage paths. |
| `<circuit>.genesis.zkey` | The pinned genesis proving key each chain starts from. |

---

## Running your own deployment (operators)

Everything below is for whoever **operates** a ceremony (deploys the app, initializes
and finalizes it). Contributors and verifiers do not need this section.

### Prerequisites

- Node.js and `pnpm` (see `packageManager` in `package.json`).
- A Vercel account (Blob + KV storage) and a GitHub OAuth App.

### 1. Install

```bash
pnpm install
```

### 2. Add circuit files and download the ptau

Place your compiled `.r1cs` files in the `circuits/` folder, then run:

```bash
pnpm setup:ptau
```

This reads each circuit's constraint count, downloads the correct
[PPoT](https://github.com/privacy-scaling-explorations/perpetualpowersoftau) `.ptau`
file, and updates `ceremony.config.ts` with the actual constraint values.

> **Note:** if the circuit artifacts path was skipped during scaffolding,
> `ceremony.config.ts` may have empty `circuits`/`tiers` arrays. Populate them manually;
> see [Configuration](#configuration).

### 3. Configure environment variables

```bash
cp .env.example .env
```

| Variable | Source | Purpose |
| --- | --- | --- |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob | Read/write zkey files |
| `KV_REST_API_URL` | Vercel KV (Upstash) | Redis endpoint for ceremony state |
| `KV_REST_API_TOKEN` | Vercel KV (Upstash) | Redis auth token |
| `GITHUB_CLIENT_ID` | GitHub OAuth App | OAuth client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App | OAuth client secret |
| `NEXTAUTH_SECRET` | Generated locally | JWT session encryption secret |
| `NEXTAUTH_URL` | Deployment URL | Canonical app URL |
| `BEACON_API_URL` | *(optional)* | Ethereum Beacon API endpoint for finalization (defaults to a public node) |

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
pnpm init:ceremony
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). `init:ceremony` only needs to run
once; after that the API routes manage ceremony state automatically.

### Deploy

```bash
vercel --prod
```

Add all environment variables in the Vercel dashboard under **Settings → Environment
Variables**, and set `NEXTAUTH_URL` to your production domain.

### Committed zkey privacy rollout

New accepted contributions rotate each circuit onto an opaque, UUID-only committed
zkey URL through the normal verified and atomic contribution flow. Existing zkeys are
not migrated: previously disclosed identities cannot be undisclosed, and rewriting live
storage directly would bypass the ceremony's continuity and commit protections.

Near ceremony close, the designated maintainer monitors any circuits still serving an
older identity-bearing URL. If such a circuit is still active and that maintainer is
eligible, they may rotate it by contributing through the normal supported flow. If the
circuit is closed, full, or no designated maintainer is eligible, leave it untouched;
any later archival or migration needs its own reviewed procedure after the published
final artifacts have been independently verified. Never copy zkeys, mutate KV or Blob
pointers, or delete live objects manually.

### Keep Vercel Fluid Compute OFF

The contribution route downloads the Powers of Tau file (often hundreds of MB) and runs
`verifyChain` inside the request, writing temp files to `/tmp` (512 MB hard cap on
Vercel).

**Turn Fluid Compute off** (Project → Settings → Functions). Fluid reuses instances and
shares `/tmp` and memory across concurrent invocations, so two contributions verifying
at once overflow `/tmp` (two copies of the ptau exceed 512 MB) and fail with
*"Verification failed. If your contribution is valid, please retry."* even though the
contribution is valid. With Fluid off, each verify runs in its own isolated instance
and fits.

Trade-off: classic functions cap `maxDuration` at 300 s (the contribute route sets
exactly that). A circuit whose verify cannot finish under 300 s must be verified on an
external worker rather than in the route.

### Scripts

| Script | Description |
| --- | --- |
| `pnpm setup:ptau` | Detect circuit constraints, download the correct PPoT ptau, and update config. |
| `pnpm init:ceremony` | Generate genesis zkeys, upload to Blob, write the manifest to KV. Outputs to `public/genesis/`. |
| `pnpm reset:ceremony` | Back up state, then wipe all KV keys and Blob objects. Refuses a finalized ceremony unless `-- --force`; asks for typed confirmation unless `-- --yes`. |
| `pnpm finalize:ceremony` | Apply the beacon (Ethereum RANDAO by default), verify the chain, export vkeys and final zkeys. Outputs to `public/finalize/`. |

#### setup:ptau

```bash
pnpm setup:ptau              # download and update constraints
pnpm setup:ptau -- --force   # re-download even if the ptau exists
pnpm setup:ptau -- --verify  # also run snarkjs ptau verification
```

#### Finalization

By default, finalization uses the RANDAO reveal from the latest finalized Ethereum
beacon-chain slot as the beacon source, which makes the beacon publicly verifiable.

```bash
pnpm finalize:ceremony                             # latest finalized slot RANDAO (default)
pnpm finalize:ceremony -- --beacon-slot 7325000    # specific pre-announced slot
pnpm finalize:ceremony -- --beacon 0xabc123        # explicit hex beacon value
pnpm finalize:ceremony -- --random-beacon          # random beacon (local testing only)
pnpm finalize:ceremony -- --force                  # finalize before the target is reached
```

For maximum verifiability, **announce a future beacon-chain slot number publicly before
running** with `--beacon-slot`. The RANDAO reveal is fetched from the Ethereum Beacon
API (`BEACON_API_URL` overrides the default public endpoint).

Finalization **seals** the ceremony the moment it starts and commits the beacon in the
same step. If a run is interrupted, the ceremony stays sealed: resume with
`pnpm finalize:ceremony -- --force` (which reuses the committed beacon, so the result is
reproducible), or run `pnpm reset:ceremony` to start over. The beacon cannot be silently
re-rolled by re-running.

#### Pin the genesis hash externally

`init:ceremony` records each circuit's genesis hash, as `genesisZkeyHash` in
`init-transcript.json` and as `initialZkeyHash` in KV. `finalize:ceremony` checks the
genesis blob against that hash before verifying the chain, which catches a swapped or
corrupted genesis blob while KV is intact.

It does **not** defend against an attacker who can write both the blob and KV: they
would rewrite the pinned hash to match a swapped genesis. To close that gap, **publish
each `genesisZkeyHash` somewhere outside this deployment's control at the start of the
ceremony**: commit it to a public Git repo, post it where contributors can read it.
Contributors and auditors can then confirm (Step 1 above) that the finalized parameters
were built on the genesis announced at the start, not one substituted later.

---

## Agent / headless contributions

An autonomous agent (e.g. `codex`) can contribute **headlessly** (no browser UI),
using the OS CSPRNG for randomness (`node:crypto.randomBytes`, the
`/dev/urandom` / `getentropy` / `BCryptGenRandom` equivalent, never mouse). The
landing page has a **FOR AGENTS** button linking to [`/llms.txt`](public/llms.txt),
a machine-readable runbook the agent follows.

The agent gets a Caburé Bearer JWT one of two ways, then runs `npx
@wonderland/cabure-cli contribute <url> --token <jwt>`:

- **GitHub (recommended, default)**: the existing CLI device flow
  (`POST/GET /api/ceremony/auth/cli`). Keeps a real GitHub identity on the
  contribution; a human authorizes a code once. Works out of the box (requires
  "Enable Device Flow" on the GitHub OAuth App).
- **Generated keypair (opt-in, fully autonomous)** (`POST /api/ceremony/auth/wallet`):
  the agent signs a challenge with an Ed25519 key it generates and gets a JWT
  under an anonymous `agent:<fp>` identity, no human. **Enable with
  `ALLOW_AGENT_AUTH=1`** (404 otherwise). Deliberately not sybil-resistant:
  acceptable for a Phase-2 setup where extra participants only add entropy.

Wallet self-test: `pnpm exec tsx scripts/agent-auth-selftest.ts`.

## Configuration

Edit [`ceremony.config.ts`](./ceremony.config.ts) to customize the ceremony name,
circuits, tiers, contribution targets, and UI copy. The full shape is defined by
`CeremonyConfig` in [`src/types/ceremony.ts`](./src/types/ceremony.ts); all user-facing
strings live in [`src/copy.ts`](./src/copy.ts).

### Circuits

Each entry in `circuits` describes one zkey chain that contributors extend.
`setup:ptau` fills in `constraints` automatically once the `.r1cs` files are in place.

```ts
circuits: [
  {
    id: "deposit",                       // unique, stable ID used in receipts and storage paths
    label: "Deposit",                    // display name in the UI
    description: "Deposit funds into the privacy pool.",
    constraints: "2,061",                // filled in by `pnpm setup:ptau`
    targetContributions: 5,              // per-circuit target
    artifacts: {
      r1csPath: "circuits/deposit.r1cs", // path relative to the project root
      ptauPath: PTAU_PATH,               // circuits/pot_final.ptau, downloaded by setup:ptau
    },
  },
  // …
],
```

### Tiers

Tiers let contributors pick a smaller commitment on the tier-selection screen. Set
`tiersEnabled: false` and omit `tiers` to skip that screen and contribute to every
circuit. Each `circuitIds` must reference IDs defined in `circuits`.

```ts
tiersEnabled: true,
tiers: [
  {
    id: "core",                          // one of: "core" | "popular" | "all"
    label: "Core circuits",
    description: "Fast contribution, essential circuits only",
    estimatedMinutes: 5,
    circuitIds: ["deposit", "ragequit"],
  },
  {
    id: "all",
    label: "Full ceremony",
    description: "Contribute to every circuit",
    estimatedMinutes: 30,
    circuitIds: ["deposit", "ragequit", "transact_1x1" /* … */],
  },
],
```

---

## Trust model & guarantees

- **1-of-N honesty.** The final keys are secure if at least one contributor was honest
  and destroyed their randomness. Contributions are computed client-side and the secret
  is never uploaded.
- **Rooted in a pinned, externally-announced genesis.** The chain can be proven to
  extend the genesis parameters that were published at the start (Step 1).
- **Server-side verification of every contribution**, and a full chain re-verification
  from the genesis at finalization, including a re-walk that matches the final key's
  embedded contribution hashes against the recorded receipts, so a key swapped via a
  leaked storage token (but no KV access) is rejected.
- **A public, unpredictable beacon** (Ethereum RANDAO) is applied last, so the result
  does not depend solely on the contributors.
- **Fully reproducible verification.** The final keys, verification keys, and a complete
  transcript are published; anyone can reproduce every check with standard tooling
  ([Verifying the ceremony yourself](#verifying-the-ceremony-yourself)).
- **Attestations prove inclusion, not honesty.** They are an optional, voluntary record;
  soundness comes from the verifiable chain and the open verifier, not from attestation
  counts.
