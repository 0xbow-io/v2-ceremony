import { createInterface } from "node:readline/promises";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { del, list, type ListBlobResultBlob } from "@vercel/blob";
import { loadEnvConfig } from "@next/env";

import {
  clearParticipantContributions,
  getJson,
  listClear,
  listRange,
  setMembers,
} from "@/lib/kv-store";
import type {
  CircuitState,
  ContributionReceipt,
  ManifestState,
} from "@/lib/ceremony-state";
import { ceremonyConfig } from "../ceremony.config";

const { storage, circuits } = ceremonyConfig;

// Client uploads land here before the contribute route copies them under
// zkeyPrefix (see the contribute route's isValidPendingBlobUrl). An aborted
// upload leaves an orphan here that no later run touches. Vercel Blob has no
// native TTL, so reset is what reclaims them; a live-ceremony sweep is a
// separate follow-up (orphan GC).
const PENDING_PREFIX = "contributions/";

async function confirmReset(force: boolean): Promise<boolean> {
  if (process.argv.includes("--yes")) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const warning = force
    ? 'Type "RESET" to wipe a finalized ceremony: '
    : 'Type "RESET" to wipe all ceremony data: ';
  const answer = await rl.question(warning);
  rl.close();
  return answer.trim() === "RESET";
}

async function listAllBlobs(
  prefix: string,
  token: string,
): Promise<ListBlobResultBlob[]> {
  const blobs: ListBlobResultBlob[] = [];
  let cursor: string | undefined;
  do {
    const result = await list({ prefix, token, cursor });
    blobs.push(...result.blobs);
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);
  return blobs;
}

// Delete every blob under a prefix, re-listing until none remain. Re-listing
// (rather than deleting a single up-front snapshot) makes the wipe exhaustive:
// it also removes anything uploaded after the snapshot was taken. Safe to loop
// because reset runs against a halted ceremony, so no new uploads arrive.
async function deleteAllByPrefix(
  prefix: string,
  token: string,
): Promise<number> {
  // Delete in modest batches: one del() with ~1000 URLs raises rate-limit
  // failures. The round cap is a safety stop — if it is hit, something is still
  // writing (reset expects a halted ceremony), so fail loudly rather than loop
  // forever.
  const DELETE_BATCH = 100;
  const MAX_ROUNDS = 1000;
  let total = 0;
  for (let round = 0; ; round++) {
    if (round >= MAX_ROUNDS) {
      throw new Error(
        `Blob deletion under "${prefix}" did not converge after ${MAX_ROUNDS} rounds. ` +
          "Halt any process still uploading, then re-run reset.",
      );
    }
    const { blobs } = await list({ prefix, token });
    if (blobs.length === 0) break;
    const urls = blobs.map((b) => b.url);
    for (let i = 0; i < urls.length; i += DELETE_BATCH) {
      await del(urls.slice(i, i + DELETE_BATCH), { token });
    }
    total += blobs.length;
  }
  return total;
}

// Snapshot everything reset is about to erase, so an accidental reset is
// recoverable. The KV state and blob listings go into state.json; the locally
// published artifacts (public/genesis, public/finalize) are copied as-is. Blob
// bytes are not downloaded — only their metadata — because chain zkeys can be
// large; the recoverable record is the KV receipts plus the published dirs.
async function backup(
  pendingBlobs: ListBlobResultBlob[],
  chainBlobs: ListBlobResultBlob[],
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.resolve(process.cwd(), "backups", stamp);
  await mkdir(dir, { recursive: true });

  const manifest = await getJson<ManifestState>(storage.manifestPath);
  const circuitStates: Record<string, CircuitState | null> = {};
  for (const c of circuits) {
    circuitStates[c.id] = await getJson<CircuitState>(
      `${storage.circuitStatePrefix}:${c.id}`,
    );
  }
  const receipts = await listRange<ContributionReceipt>(storage.receiptsPath);
  const participants = await setMembers(storage.participantsIndexPath);

  await writeFile(
    path.join(dir, "state.json"),
    JSON.stringify(
      { manifest, circuitStates, receipts, participants, pendingBlobs, chainBlobs },
      null,
      2,
    ),
  );

  for (const sub of ["genesis", "finalize"]) {
    const src = path.resolve(process.cwd(), "public", sub);
    // Ignore only a missing dir (e.g. reset before finalize). Any other copy
    // failure must abort the reset: this backup runs before the wipe, so
    // swallowing it would destroy data with no recoverable copy.
    await cp(src, path.join(dir, sub), { recursive: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  }

  return dir;
}

async function main() {
  loadEnvConfig(process.cwd(), true);

  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "BLOB_READ_WRITE_TOKEN is required. Ensure it is set in your shell or loaded via .env/.env.local.",
    );
  }
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    throw new Error(
      "KV_REST_API_URL and KV_REST_API_TOKEN are required. Pull env vars from Vercel or set them in .env/.env.local.",
    );
  }

  // Guard a finalized ceremony. reset wipes the live manifest, receipts, circuit
  // states and zkey blobs; the published transcript and final zkeys under
  // public/finalize/ are on disk and survive, but the running app loses its
  // status/receipt/download state for good. Only beaconApplied is guarded, not
  // finalizingAt: reset is the documented recovery path for an interrupted
  // finalize seal.
  const force = process.argv.includes("--force");
  const manifest = await getJson<ManifestState>(storage.manifestPath);
  if (manifest?.beaconApplied && !force) {
    const when = manifest.finalizedAt
      ? ` on ${new Date(manifest.finalizedAt).toISOString()}`
      : "";
    throw new Error(
      `Ceremony is finalized (beacon applied${when}). Resetting erases the live ` +
        "manifest, receipts, circuit states and all zkey blobs. Pass --force to wipe anyway.",
    );
  }

  if (!(await confirmReset(force))) {
    console.log("Reset cancelled.");
    process.exit(0);
  }

  // Snapshot the blobs once for the backup record. Deletion below re-lists
  // independently, so anything uploaded after this snapshot is still deleted
  // (it just is not in the backup listing).
  console.log("Listing Vercel Blob objects...");
  const chainBlobs = await listAllBlobs(`${storage.zkeyPrefix}/`, token);
  const pendingBlobs = await listAllBlobs(PENDING_PREFIX, token);

  console.log("Backing up state...");
  const backupDir = await backup(pendingBlobs, chainBlobs);
  console.log(`  Backup written to ${backupDir}`);

  // Delete blobs before KV. If a transient blob failure aborts the run, KV is
  // still intact, so the system stays in a coherent "ceremony still here" state
  // and the operator can safely retry — rather than being left with the live
  // state gone but chain/pending blobs orphaned. The backup above is taken
  // before either deletion, so data-loss safety does not depend on the order.
  console.log("Deleting Vercel Blob objects (chain + pending uploads)...");
  const deletedChain = await deleteAllByPrefix(`${storage.zkeyPrefix}/`, token);
  const deletedPending = await deleteAllByPrefix(PENDING_PREFIX, token);
  console.log(
    `  Deleted ${deletedChain} chain blob(s) and ${deletedPending} pending upload(s).`,
  );

  console.log("Deleting Redis keys...");
  const redisKeys = [
    storage.manifestPath,
    storage.receiptsPath,
    ...circuits.map((c) => `${storage.circuitStatePrefix}:${c.id}`),
    ...circuits.map((c) => `${storage.manifestPath}:lock:${c.id}`),
  ];

  const deletedCounts = await Promise.all(
    redisKeys.map((key) => listClear(key)),
  );
  const clearedParticipants = await clearParticipantContributions({
    participantsIndexKey: storage.participantsIndexPath,
    participantContributionsPrefix: storage.participantContributionsPrefix,
  });
  const deletedKeys = deletedCounts.reduce((sum, n) => sum + n, 0);
  console.log(
    `  Deleted ${deletedKeys} keys and ${clearedParticipants} participant index entries.`,
  );

  console.log("Ceremony data reset complete.");
  process.exit(0);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
