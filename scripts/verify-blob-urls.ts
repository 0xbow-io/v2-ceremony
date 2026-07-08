// READ-ONLY diagnostic. Checks each circuit's KV state for the stale-Blob-store
// problem: ptauUrl / initialZkeyUrl may point at a deleted Blob store (404),
// while live data sits on the current store. It reads KV and issues public
// HEAD/GET requests only — it never writes KV, Blob, or anything else.
//
//   KV_REST_API_URL=... KV_REST_API_TOKEN=... npx tsx scripts/verify-blob-urls.ts
//
// Optional: LIVE_BLOB_HOST=<hostname> to force the target store host instead of
// inferring it from a circuit's currentZkeyUrl.

import { createHash } from "node:crypto";
import process from "node:process";

import { loadEnvConfig } from "@next/env";

import type { CircuitState } from "@/lib/ceremony-state";
import { getJson } from "@/lib/kv-store";
import { ceremonyConfig } from "../ceremony.config";

loadEnvConfig(process.cwd(), true);

if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
  console.error(
    "Missing KV_REST_API_URL / KV_REST_API_TOKEN. Provide the real Upstash " +
      "credentials (Upstash dashboard or the Vercel integration).",
  );
  process.exit(1);
}

async function headStatus(url: string): Promise<number | string> {
  try {
    const r = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(30_000),
    });
    return r.status;
  } catch (error) {
    return `ERR ${(error as Error).name}`;
  }
}

async function sha256OfUrl(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!r.ok) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    return `0x${createHash("sha256").update(bytes).digest("hex")}`;
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "(invalid-url)";
  }
}

// Swap only the hostname, keep the pathname — the store migration preserved paths.
function repoint(url: string, liveHost: string): string {
  const u = new URL(url);
  u.hostname = liveHost;
  return u.toString();
}

async function main() {
  const prefix = ceremonyConfig.storage.circuitStatePrefix;
  const states = new Map<string, CircuitState>();

  for (const circuit of ceremonyConfig.circuits) {
    const state = await getJson<CircuitState>(`${prefix}:${circuit.id}`);
    if (state) states.set(circuit.id, state);
  }

  // Determine the live store host: an explicit override, else the host of any
  // currentZkeyUrl that actually resolves (that is the store the app writes to).
  let liveHost = process.env.LIVE_BLOB_HOST?.trim() || "";
  if (!liveHost) {
    for (const state of states.values()) {
      if (state.currentZkeyUrl && (await headStatus(state.currentZkeyUrl)) === 200) {
        liveHost = hostOf(state.currentZkeyUrl);
        break;
      }
    }
  }
  console.log(`Live store host: ${liveHost || "(could not determine — set LIVE_BLOB_HOST)"}\n`);

  const summary = { healthy: 0, repointable: 0, broken: 0, missing: 0 };

  for (const circuit of ceremonyConfig.circuits) {
    const state = states.get(circuit.id);
    if (!state) {
      console.log(`[${circuit.id}] NO KV STATE`);
      summary.missing++;
      continue;
    }

    const ptauNow = await headStatus(state.ptauUrl);
    const genNow = await headStatus(state.initialZkeyUrl);

    if (ptauNow === 200 && genNow === 200) {
      console.log(
        `[${circuit.id}] OK — ptau & genesis resolve (host ${hostOf(state.ptauUrl)})`,
      );
      summary.healthy++;
      continue;
    }

    console.log(`[${circuit.id}] STALE — contributions=${state.totalContributions}`);
    console.log(`   ptauUrl     ${ptauNow}  host=${hostOf(state.ptauUrl)}`);
    console.log(`   initialZkey ${genNow}  host=${hostOf(state.initialZkeyUrl)}`);

    if (!liveHost) {
      summary.broken++;
      continue;
    }

    // What a hostname-only repoint to the live store WOULD produce (not applied).
    const ptauFixed = repoint(state.ptauUrl, liveHost);
    const genFixed = repoint(state.initialZkeyUrl, liveHost);
    const ptauFixedStatus = await headStatus(ptauFixed);
    const genFixedSha = await sha256OfUrl(genFixed);
    const genHashOk = genFixedSha !== null && genFixedSha === state.initialZkeyHash;

    console.log(`   → repoint ptau     HEAD=${ptauFixedStatus}  (${ptauFixed})`);
    console.log(
      `   → repoint genesis  sha256Match=${genHashOk}  (expected ${state.initialZkeyHash.slice(0, 12)}…, got ${genFixedSha ? genFixedSha.slice(0, 12) + "…" : "unreachable"})`,
    );

    if (ptauFixedStatus === 200 && genHashOk) {
      console.log(`   ✓ REPOINTABLE — a hostname swap to ${liveHost} would fix this circuit`);
      summary.repointable++;
    } else {
      console.log(`   ✗ NOT repointable — artifacts absent/mismatched on the live store (need re-upload)`);
      summary.broken++;
    }
  }

  console.log(
    `\nSummary: healthy=${summary.healthy} repointable=${summary.repointable} broken=${summary.broken} missing=${summary.missing}`,
  );
  console.log("No changes were made (read-only).");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
