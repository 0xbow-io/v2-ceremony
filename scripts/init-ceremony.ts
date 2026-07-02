import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { put } from "@vercel/blob";
import { loadEnvConfig } from "@next/env";
import {
  generateInitialZkey,
  parseMpcParams,
  verify,
} from "@wonderland/cabure-crypto";

import { getEndDateDeadlineMs } from "@/lib/ceremony-state";
import {
  clearParticipantContributions,
  getJson,
  listClear,
  setJson,
} from "@/lib/kv-store";
import { ceremonyConfig } from "../ceremony.config";

// snarkjs/fastfile does not always close file handles explicitly. Node 25+
// treats GC-collected handles as a hard error. Safe to suppress.
process.on("uncaughtException", (error: NodeJS.ErrnoException) => {
  if (
    error.code === "ERR_INVALID_STATE" &&
    error.message.includes("FileHandle")
  ) {
    return;
  }
  console.error(error);
  process.exit(1);
});

const GENESIS_CHAIN_HASH = `0x${"0".repeat(64)}`;
const OUTPUT_DIR = path.resolve(process.cwd(), "public", "genesis");

type QueueEntry = {
  participantId: string;
  joinedAt: number;
};

type CircuitState = {
  id: string;
  totalContributions: number;
  latestContributionHash: string | null;
  chainHash: string;
  queue: QueueEntry[];
  currentZkeyPath: string;
  currentZkeyUrl: string;
  initialZkeyHash: string;
  initialZkeyUrl: string;
  ptauUrl: string;
  headContributionHash: string | null;
  csHash: string;
};

type ManifestState = {
  ceremonyName: string;
  targetContributions: number;
  endDate: string | null;
  startedAt: number;
  circuits: Array<{ id: string }>;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function sha256hex(data: Uint8Array): string {
  return `0x${createHash("sha256").update(data).digest("hex")}`;
}

async function readArtifact(relativePath: string): Promise<Uint8Array> {
  const fullPath = path.resolve(process.cwd(), relativePath);
  try {
    const data = await readFile(fullPath);
    return new Uint8Array(data);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `Missing circuit artifact: ${relativePath}. Add it to the circuits/ folder.`,
      );
    }
    throw error;
  }
}

async function main() {
  loadEnvConfig(process.cwd(), true);

  console.log("=== Initialize Ceremony ===\n");

  if (ceremonyConfig.circuits.length === 0) {
    throw new Error(
      "No circuits configured in ceremony.config.ts — nothing to initialize.",
    );
  }

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

  const force = process.argv.includes("--force");

  if (!force) {
    const existing = await getJson<ManifestState>(
      ceremonyConfig.storage.manifestPath,
    );
    if (existing) {
      console.log(
        "Manifest already exists. Re-run with --force to overwrite it.",
      );
      return;
    }
  }

  const endDate = ceremonyConfig.endDate?.trim() || null;
  getEndDateDeadlineMs(endDate);

  console.log(`Ceremony:    ${ceremonyConfig.name}`);
  console.log(`Circuits:    ${ceremonyConfig.circuits.length}`);
  console.log(
    `Target:      ${ceremonyConfig.targetContributions} contributions`,
  );
  console.log(`End date:    ${endDate ?? "(none)"}`);
  console.log();

  await mkdir(OUTPUT_DIR, { recursive: true });

  const circuitSummaries: Array<{
    circuitId: string;
    label: string;
    genesisZkeyHash: string;
    csHash: string;
    genesisZkeySize: number;
    genesisZkeyUrl: string;
    genesisZkeyPath: string;
    localZkeyPath: string;
    r1csPath: string;
    ptauPath: string;
  }> = [];

  // A ptau is ~300 MB. To avoid re-reading a shared ptau per circuit without
  // holding every distinct ptau for the whole loop (which would OOM a ceremony
  // with many different ptau files), keep each buffer in memory only while
  // circuits still need it, then drop it. ptauUsesLeft counts remaining uses per
  // path; the buffer is evicted after its last use.
  const ptauUsesLeft = new Map<string, number>();
  for (const c of ceremonyConfig.circuits) {
    const p = c.artifacts.ptauPath;
    ptauUsesLeft.set(p, (ptauUsesLeft.get(p) ?? 0) + 1);
  }
  const ptauBytesByPath = new Map<string, Uint8Array>();
  // URL per path is tiny; keep it all loop long to dedupe uploads of a shared ptau.
  const ptauUrlByPath = new Map<string, string>();

  for (const circuit of ceremonyConfig.circuits) {
    console.log(`[${circuit.id}] Generating genesis zkey...`);

    console.log(`  Loading r1cs: ${circuit.artifacts.r1csPath}`);
    const r1cs = await readArtifact(circuit.artifacts.r1csPath);

    const ptauPath = circuit.artifacts.ptauPath;
    let ptau = ptauBytesByPath.get(ptauPath);
    if (!ptau) {
      console.log(`  Loading ptau: ${ptauPath}`);
      ptau = await readArtifact(ptauPath);
    } else {
      console.log(`  Reusing loaded ptau: ${ptauPath}`);
    }
    // Retain the buffer only while later circuits still need it; drop it after
    // the last use so a many-distinct-ptau run does not accumulate buffers.
    const usesLeft = (ptauUsesLeft.get(ptauPath) ?? 1) - 1;
    ptauUsesLeft.set(ptauPath, usesLeft);
    if (usesLeft > 0) {
      ptauBytesByPath.set(ptauPath, ptau);
    } else {
      ptauBytesByPath.delete(ptauPath);
    }

    console.log(`  Running Phase 2 setup...`);
    const zkey = await generateInitialZkey(ptau, r1cs);
    const genesisHash = sha256hex(zkey);

    console.log(`  Genesis zkey size: ${formatBytes(zkey.length)}`);
    console.log(`  Genesis zkey hash: ${genesisHash}`);

    // Catch a corrupt genesis (e.g. swapped r1cs/ptau, broken toolchain)
    // before it becomes the root everyone builds on.
    console.log(`  Verifying genesis zkey...`);
    const genesisValid = await verify(r1cs, ptau, zkey);
    if (!genesisValid) {
      throw new Error(
        `Genesis zkey for ${circuit.id} failed verification. ` +
          "Check that the r1cs and ptau inputs are correct.",
      );
    }

    // Read the circuit identity (csHash) from the genesis MPC params. The
    // continuity gate pins it so a first contribution to the wrong circuit is
    // rejected. The genesis has no contributions yet, so cap the parse at 0.
    const { csHash } = await parseMpcParams(zkey, { maxContributions: 0 });

    // Immutable copy: contributions overwrite `current.zkey`, so the original
    // parameters must live at their own path to stay checkable for the whole
    // ceremony. `current.zkey` is the mutable live pointer.
    //
    // allowOverwrite stays false on a plain re-run so it cannot silently replace
    // the pinned root once a ceremony is live. --force flips it to true, which
    // replaces the pin in a single put. We never delete first: a delete-then-put
    // would leave a window where a transient put failure strands the ceremony
    // with no genesis pin at all. An overwriting put either succeeds with the new
    // pin or fails with the old pin still in place.
    console.log(`  Uploading genesis zkey to Vercel Blob...`);
    const genesisBlobPath = `${ceremonyConfig.storage.zkeyPrefix}/${circuit.id}/genesis.zkey`;

    const genesisUpload = await put(genesisBlobPath, Buffer.from(zkey), {
      access: "public",
      token,
      contentType: "application/octet-stream",
      addRandomSuffix: false,
      allowOverwrite: force,
    }).catch((error) => {
      throw new Error(
        `Failed to pin genesis for ${circuit.id} at ${genesisBlobPath}. ` +
          "A genesis blob may already exist; re-run with --force to replace it, " +
          "or run reset:ceremony for a full reset. " +
          `Cause: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    console.log(`  Genesis pinned at: ${genesisUpload.url}`);

    const blobPath = `${ceremonyConfig.storage.zkeyPrefix}/${circuit.id}/current.zkey`;
    const zkeyUpload = await put(blobPath, Buffer.from(zkey), {
      access: "public",
      token,
      contentType: "application/octet-stream",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    console.log(`  Uploaded live pointer to: ${zkeyUpload.url}`);

    const localZkeyFile = `${circuit.id}.genesis.zkey`;
    const localZkeyPath = path.join(OUTPUT_DIR, localZkeyFile);
    await writeFile(localZkeyPath, Buffer.from(zkey));
    console.log(`  Saved locally to: public/genesis/${localZkeyFile}`);

    // Publish this circuit's ptau for the contribute route's verifyChain — it is
    // not on the deployed function's filesystem. Content-addressed so a changed
    // ptau gets a new URL (busts the route's URL-keyed cache). Deduped by path:
    // circuits sharing one ptau upload it once.
    let circuitPtauUrl = ptauUrlByPath.get(ptauPath);
    if (!circuitPtauUrl) {
      const ptauHash = createHash("sha256").update(ptau).digest("hex");
      console.log(
        `  Publishing ptau (${formatBytes(ptau.length)}) to Vercel Blob...`,
      );
      // Buffer VIEW over the existing bytes — avoids copying ~288 MB that
      // `Buffer.from(ptau)` would (it allocates and memcpys a second copy).
      const ptauBody = Buffer.from(
        ptau.buffer,
        ptau.byteOffset,
        ptau.byteLength,
      );
      // Throttle progress to one line per 10% so the log isn't flooded.
      let lastLoggedDecile = -1;
      const startedUpload = Date.now();
      const ptauUpload = await put(
        `${ceremonyConfig.storage.zkeyPrefix}/pot-${ptauHash}.ptau`,
        ptauBody,
        {
          access: "public",
          token,
          contentType: "application/octet-stream",
          addRandomSuffix: false,
          allowOverwrite: true,
          // Chunked, parallel, resumable upload. Required for a file this big:
          // a single-shot put stalls mid-body on a ~288 MB payload and, with no
          // client timeout, never returns. Multipart also parallelizes the parts
          // so the upload is faster on top of being reliable.
          multipart: true,
          onUploadProgress: ({ loaded, total, percentage }) => {
            const decile = Math.floor(percentage / 10);
            if (decile > lastLoggedDecile) {
              lastLoggedDecile = decile;
              console.log(
                `    ptau upload: ${percentage.toFixed(0)}%` +
                  ` (${formatBytes(loaded)} / ${formatBytes(total)})`,
              );
            }
          },
        },
      );
      const uploadSecs = ((Date.now() - startedUpload) / 1000).toFixed(1);
      circuitPtauUrl = ptauUpload.url;
      ptauUrlByPath.set(ptauPath, circuitPtauUrl);
      console.log(`  Ptau published in ${uploadSecs}s at: ${circuitPtauUrl}`);
    } else {
      console.log(`  Ptau already published at: ${circuitPtauUrl}`);
    }

    const circuitState: CircuitState = {
      id: circuit.id,
      totalContributions: 0,
      latestContributionHash: genesisHash,
      chainHash: GENESIS_CHAIN_HASH,
      queue: [],
      currentZkeyPath: zkeyUpload.pathname,
      currentZkeyUrl: zkeyUpload.url,
      initialZkeyHash: genesisHash,
      initialZkeyUrl: genesisUpload.url,
      ptauUrl: circuitPtauUrl,
      headContributionHash: null,
      csHash,
    };

    const kvKey = `${ceremonyConfig.storage.circuitStatePrefix}:${circuit.id}`;
    await setJson(kvKey, circuitState);
    console.log(`  Circuit state saved to KV: ${kvKey}`);

    circuitSummaries.push({
      circuitId: circuit.id,
      label: circuit.label,
      genesisZkeyHash: genesisHash,
      csHash,
      genesisZkeySize: zkey.length,
      genesisZkeyUrl: genesisUpload.url,
      genesisZkeyPath: genesisUpload.pathname,
      localZkeyPath: `public/genesis/${localZkeyFile}`,
      r1csPath: circuit.artifacts.r1csPath,
      ptauPath: circuit.artifacts.ptauPath,
    });

    console.log();
  }

  // Each circuit's ptau was published in the loop above (see ptauUrlByPath),
  // and its URL recorded on that circuit's KV state. The manifest no longer
  // carries a single global ptau URL — circuits may use different ptau files.

  const startedAt = Date.now();
  const manifest: ManifestState = {
    ceremonyName: ceremonyConfig.name,
    targetContributions: ceremonyConfig.targetContributions,
    endDate,
    startedAt,
    circuits: circuitSummaries.map((c) => ({ id: c.circuitId })),
  };

  await setJson(ceremonyConfig.storage.manifestPath, manifest);
  console.log(`Manifest saved to KV: ${ceremonyConfig.storage.manifestPath}`);

  await listClear(ceremonyConfig.storage.receiptsPath);
  console.log(`Receipts list cleared: ${ceremonyConfig.storage.receiptsPath}`);

  const clearedParticipants = await clearParticipantContributions({
    participantsIndexKey: ceremonyConfig.storage.participantsIndexPath,
    participantContributionsPrefix:
      ceremonyConfig.storage.participantContributionsPrefix,
  });
  console.log(
    `Contribution index cleared: ${clearedParticipants} participant(s).`,
  );
  console.log();

  console.log("Generating initialization transcript...");
  const transcript = {
    ceremony: {
      name: ceremonyConfig.name,
      slug: ceremonyConfig.slug,
      targetContributions: ceremonyConfig.targetContributions,
      endDate,
      startedAt,
      initializedAt: new Date(startedAt).toISOString(),
      genesisChainHash: GENESIS_CHAIN_HASH,
    },
    circuits: circuitSummaries,
    storage: {
      manifestPath: ceremonyConfig.storage.manifestPath,
      circuitStatePrefix: ceremonyConfig.storage.circuitStatePrefix,
      receiptsPath: ceremonyConfig.storage.receiptsPath,
      participantContributionsPrefix:
        ceremonyConfig.storage.participantContributionsPrefix,
      participantsIndexPath: ceremonyConfig.storage.participantsIndexPath,
      zkeyPrefix: ceremonyConfig.storage.zkeyPrefix,
    },
  };

  const transcriptPath = path.join(OUTPUT_DIR, "init-transcript.json");
  await writeFile(transcriptPath, JSON.stringify(transcript, null, 2));
  console.log(`Transcript saved to public/genesis/init-transcript.json`);

  console.log();
  console.log("=== Ceremony initialized ===");
  console.log(`  Name:          ${ceremonyConfig.name}`);
  console.log(`  Started at:    ${new Date(startedAt).toISOString()}`);
  console.log(`  Circuits:      ${circuitSummaries.length}`);
  console.log(
    `  Target:        ${ceremonyConfig.targetContributions} contributions`,
  );
  console.log(`  End date:      ${endDate ?? "(none)"}`);
  console.log(`  Genesis zkeys: public/genesis/*.genesis.zkey`);
  console.log(`  Transcript:    public/genesis/init-transcript.json`);

  process.exit(0);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
