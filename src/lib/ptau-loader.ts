import { readFile } from "node:fs/promises";
import path from "node:path";

// The ptau is too large to bundle and is absent from the deployed function's
// filesystem, but the contribute route needs it for verifyChain. Load from a
// URL and cache in memory (survives warm invocations) to avoid re-downloading.
// Prefer a local file when present, so `next dev` and the operator scripts read
// the on-disk copy with no download.
//
// Do NOT cache the ptau to /tmp. verifyChain writes the ptau (~300 MB) plus the
// genesis and latest zkey into /tmp, and Vercel caps /tmp at 512 MB. A second
// 300 MB ptau copy here pushes the total past that cap, so writes fail with
// ENOSPC and verifyChain returns false for a valid contribution.
let cached: { key: string; bytes: Uint8Array } | null = null;

export async function loadPtau(options: {
  url?: string;
  localPath?: string;
}): Promise<Uint8Array> {
  if (options.localPath) {
    try {
      const data = await readFile(
        path.resolve(process.cwd(), options.localPath),
      );
      return new Uint8Array(data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Not on disk (e.g. a deployed function): fall through to the URL.
    }
  }

  if (!options.url) {
    throw new Error(
      "ptau is unavailable: no local file and no ptauUrl for this circuit. " +
        "Re-run init:ceremony to publish the ptau. In production this is the " +
        "only fix: verification is mandatory there, and the verifyContributions " +
        "flag disables it only in dev / CI.",
    );
  }

  if (cached?.key === options.url) {
    return cached.bytes;
  }

  // Time-box the download. The signal aborts the whole request, including the
  // body stream, so a stalled ~300 MB transfer fails fast with our own error
  // instead of an opaque platform kill. Keep this plus the genesis fetch and
  // verify under the deploy's function timeout, or the platform kills first.
  try {
    const response = await fetch(options.url, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new Error(
        `Failed to download ptau from ${options.url}: ${response.status}`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    cached = { key: options.url, bytes };
    return bytes;
  } catch (error) {
    if ((error as Error).name === "TimeoutError") {
      throw new Error(`ptau download timed out from ${options.url}`);
    }
    throw error;
  }
}
