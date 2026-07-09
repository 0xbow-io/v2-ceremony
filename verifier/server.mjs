// Standalone contribution verifier for the Privacy Pools v2 ceremony.
//
// One job: given public Blob URLs for the ptau, the pinned genesis, and a
// candidate zkey (plus their sha256 pins), fetch them and run verifyChain from
// the SAME @wonderland/cabure-crypto the Vercel route uses, then return
// {valid: boolean}. It holds no ceremony state, no KV, no Blob token — every
// input is a public HTTPS URL. Runs on Cloud Run so the heavy ptau download +
// snarkjs pairings run off the Vercel function.
//
// Signalling contract with the route (contribute/route.ts):
//   200 {valid:true}   -> route commits
//   200 {valid:false}  -> route returns non-consuming 400 (definitive bad chain)
//   any non-2xx / error -> route returns non-consuming 503 (verify couldn't RUN)
// So this server only ever emits {valid:false} for a genuine verifyChain=false;
// every infra fault (download failure, hash-pin mismatch, crash) is a 4xx/5xx.

import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";

// cabure-crypto's ESM bundle does a dynamic require() that plain Node refuses
// (the Next app only gets away with the ESM entry because webpack rewrites it).
// Load the package's CJS build via the "require" export condition instead —
// Node's native require() supports the dynamic require the bundle needs.
const require = createRequire(import.meta.url);
const { verifyChain, parseMpcParams } = require("@wonderland/cabure-crypto");

// snarkjs (via fastfile) leaves file handles for the GC to close; on recent Node
// a GC-closed FileHandle throws an uncaught async ERR_INVALID_STATE that would
// crash the process mid-verify. Suppress only that benign error; re-raise the
// rest. (Copied from the app's src/lib/snarkjs-gc-guard.ts — same root cause.)
process.on("uncaughtException", (error) => {
  if (
    error?.code === "ERR_INVALID_STATE" &&
    String(error?.message).includes("FileHandle")
  ) {
    console.warn(`[verifier] suppressed snarkjs/fastfile GC handle error: ${error.message}`);
    return;
  }
  throw error;
});

const PORT = Number(process.env.PORT) || 8080;
const TOKEN = process.env.VERIFIER_TOKEN?.trim();
const MAX_BODY_BYTES = 16 * 1024; // request body is tiny JSON (URLs + hashes)
const BLOB_HOST_SUFFIX = ".public.blob.vercel-storage.com";

if (!TOKEN) {
  // Fail closed: an unauthenticated verifier is a free compute/DoS oracle.
  console.error("VERIFIER_TOKEN is required but not set. Refusing to start.");
  process.exit(1);
}

// Only fetch public Vercel Blob URLs over https. Blocks SSRF to link-local /
// metadata endpoints if a caller (e.g. one holding a stolen token) sends a
// crafted URL. The sha256 pins below make the exact origin non-load-bearing,
// but we still refuse anything that isn't a Blob URL.
function isAllowedUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname.endsWith(BLOB_HOST_SUFFIX);
  } catch {
    return false;
  }
}

function sha256Hex(bytes) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

// ptau is one shared ~288 MB file across all circuits — cache it for the
// instance lifetime. Genesis is small and cached too, but its hash is re-checked
// against the request pin on every call (evict + refetch on mismatch), so a
// swapped genesis can never be trusted from cache.
let ptauCache = null; // { url, bytes }
let genesisCache = null; // { url, bytes }

async function fetchBytes(url, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new Error(`failed to download ${label} from ${url}: HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function loadPtau(url) {
  if (ptauCache?.url === url) return ptauCache.bytes;
  const bytes = await fetchBytes(url, "ptau");
  ptauCache = { url, bytes };
  return bytes;
}

async function loadGenesis(url, expectedSha256) {
  if (genesisCache?.url === url && sha256Hex(genesisCache.bytes) === expectedSha256) {
    return genesisCache.bytes;
  }
  const bytes = await fetchBytes(url, "genesis");
  const actual = sha256Hex(bytes);
  if (actual !== expectedSha256) {
    genesisCache = null;
    throw new Error("pinned genesis does not match its recorded hash");
  }
  genesisCache = { url, bytes };
  return bytes;
}

function tokenOk(req) {
  const provided = req.headers["x-verifier-token"];
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

async function handleVerify(req, res) {
  if (!tokenOk(req)) return json(res, 401, { error: "unauthorized" });

  let params;
  try {
    params = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: "invalid JSON body" });
  }

  const { ptauUrl, genesisUrl, genesisSha256, zkeyUrl, zkeySha256, maxContributions } =
    params ?? {};
  if (
    typeof ptauUrl !== "string" ||
    typeof genesisUrl !== "string" ||
    typeof genesisSha256 !== "string" ||
    typeof zkeyUrl !== "string"
  ) {
    return json(res, 400, { error: "missing or malformed fields" });
  }
  // Legacy per-attempt hash pin: optional now. Newer callers promote the zkey
  // into a coordinator-owned path and verify THAT copy, so the bytes verified
  // are already the bytes committed and no pin is needed. When a caller does send
  // one we still enforce it (below), so an old route + new worker stays safe.
  if (zkeySha256 !== undefined && typeof zkeySha256 !== "string") {
    return json(res, 400, { error: "malformed zkeySha256" });
  }
  // When present, the caller wants the MPC view back (csHash + head/link hashes)
  // and this bounds the parse so a forged count is rejected before it is walked.
  const wantMpc = maxContributions !== undefined;
  if (wantMpc && (!Number.isInteger(maxContributions) || maxContributions < 0)) {
    return json(res, 400, { error: "malformed maxContributions" });
  }
  if (![ptauUrl, genesisUrl, zkeyUrl].every(isAllowedUrl)) {
    return json(res, 400, { error: "url not allowed (must be a public Blob https URL)" });
  }

  // Fetch inputs + enforce the genesis pin. A pin mismatch is an infra/config
  // fault (or a swapped blob), NOT an invalid chain -> throw -> 5xx -> route 503.
  const started = Date.now();
  let ptau, genesis, zkey;
  try {
    [ptau, genesis, zkey] = await Promise.all([
      loadPtau(ptauUrl),
      loadGenesis(genesisUrl, genesisSha256),
      fetchBytes(zkeyUrl, "zkey"),
    ]);
  } catch (error) {
    console.error("[verifier] input fetch/pin failed:", error);
    return json(res, 502, { error: "could not load verification inputs" });
  }

  const zkeyHash = sha256Hex(zkey);
  if (zkeySha256 !== undefined && zkeyHash !== zkeySha256) {
    // Legacy pin path: the bytes at zkeyUrl are not the pinned bytes. Refuse.
    console.error(`[verifier] zkey hash mismatch: got ${zkeyHash}, expected ${zkeySha256}`);
    return json(res, 422, { error: "zkey does not match the pinned hash" });
  }

  // Read the MPC section (snarkjs zkey section 10) BEFORE the expensive verify:
  // a malformed zkey or a forged contribution count is a definitive bad
  // submission, so report it invalid without paying for pairings. Cheap
  // (bounds-checked reads + at most two Blake2b hashes, no pairings). Only when
  // the caller asked for it (maxContributions present).
  let mpcView = null;
  if (wantMpc) {
    try {
      const mpc = await parseMpcParams(zkey, { maxContributions });
      const count = mpc.contributions.length;
      mpcView = {
        csHash: mpc.csHash,
        count,
        headHash: count >= 1 ? mpc.contributions[count - 1].hash() : null,
        linkHash: count >= 2 ? mpc.contributions[count - 2].hash() : null,
      };
    } catch (error) {
      console.warn(`[verifier] mpc parse rejected: ${error?.message}`);
      return json(res, 200, { valid: false });
    }
  }

  // verifyChain swallows internal throws and returns false. A false here is
  // treated as a definitive invalid chain (route -> non-consuming 400). If
  // verifyChain itself throws (should not, but e.g. OOM path), that is an infra
  // fault -> 5xx -> route 503.
  let valid;
  try {
    valid = await verifyChain(ptau, genesis, zkey);
  } catch (error) {
    console.error("[verifier] verifyChain threw:", error);
    return json(res, 500, { error: "verifier crashed" });
  }

  console.log(
    `[verifier] verify done valid=${valid} ms=${Date.now() - started} zkeyBytes=${zkey.length}`,
  );
  if (!valid) return json(res, 200, { valid: false });
  // Return the sha256 (so the route can record it without re-hashing) and, when
  // requested, the MPC view the route's continuity gate needs.
  return json(res, 200, { valid: true, zkeySha256: zkeyHash, ...(mpcView ?? {}) });
}

const server = createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && req.url === "/verify") {
    handleVerify(req, res).catch((error) => {
      console.error("[verifier] unhandled error:", error);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    });
    return;
  }
  json(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`[verifier] listening on :${PORT}`);
});
