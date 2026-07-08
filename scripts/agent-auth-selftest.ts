/**
 * Self-test for the agent (wallet) auth route — exercises the real Route
 * Handler directly (no server), mirroring exactly what /llms.txt tells an agent
 * to do: generate an Ed25519 keypair, sign the discovered challenge, exchange it
 * for a Caburé JWT, and confirm the JWT is one getParticipant() would accept.
 *
 *   corepack pnpm exec tsx scripts/agent-auth-selftest.ts
 */
import { createHmac, generateKeyPairSync, sign } from "node:crypto";

// Env must be set before importing anything that pulls in src/lib/env.
process.env.BLOB_READ_WRITE_TOKEN ||= "test";
process.env.KV_REST_API_URL ||= "https://test.invalid";
process.env.KV_REST_API_TOKEN ||= "test";
process.env.GITHUB_CLIENT_ID ||= "test";
process.env.GITHUB_CLIENT_SECRET ||= "test";
process.env.NEXTAUTH_SECRET ||= "selftest-secret-please-ignore";
process.env.NEXTAUTH_URL ||= "http://localhost:3737";
process.env.ALLOW_AGENT_AUTH = "1";

const SECRET = process.env.NEXTAUTH_SECRET!;
const BASE = "http://localhost:3737";

function req(method: string, body?: unknown): Request {
  return new Request(`${BASE}/api/ceremony/auth/wallet`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function verifyJwt(token: string): { sub: string; name: string; exp: number } | null {
  const [h, b, s] = token.split(".");
  if (!h || !b || !s) return null;
  const expected = createHmac("sha256", SECRET).update(`${h}.${b}`).digest("base64url");
  if (s !== expected) return null;
  return JSON.parse(Buffer.from(b, "base64url").toString());
}

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
};

async function main() {
const { GET, POST } = await import("../src/app/api/ceremony/auth/wallet/route");

// 1) discovery (GET) returns the challenge template + slug
const info = await (await GET()).json();
check("GET returns ed25519 challenge template", info.scheme === "ed25519" && typeof info.challengeTemplate === "string" && info.challengeTemplate.includes("<unix-seconds>"), info.challengeTemplate);

// 2) happy path — generate keypair, sign, POST → valid JWT
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const timestamp = Math.floor(Date.now() / 1000);
const message = info.challengeTemplate.replace("<unix-seconds>", String(timestamp));
const publicKeyB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const signature = sign(null, Buffer.from(message), privateKey).toString("base64");

const okRes = await POST(req("POST", { publicKey: publicKeyB64, signature, timestamp }));
const okBody = await okRes.json();
check("POST valid signature → 200 + token", okRes.status === 200 && typeof okBody.token === "string", `status=${okRes.status}`);
const payload = okBody.token ? verifyJwt(okBody.token) : null;
check("minted JWT verifies against NEXTAUTH_SECRET", !!payload, payload ? "" : "bad signature");
check("participantId is agent:<fp> and matches JWT sub", payload?.sub === okBody.participantId && /^agent:[0-9a-f]{16}$/.test(okBody.participantId ?? ""), okBody.participantId);
check("JWT expiry ~7 days out", !!payload && payload.exp - Math.floor(Date.now() / 1000) > 6 * 86400, payload ? `${Math.round((payload.exp - Date.now() / 1000) / 86400)}d` : "");

// 3) tampered signature → 401
const badSig = Buffer.from(signature, "base64");
badSig[0] ^= 0xff;
const badRes = await POST(req("POST", { publicKey: publicKeyB64, signature: badSig.toString("base64"), timestamp }));
check("POST tampered signature → 401", badRes.status === 401, `status=${badRes.status}`);

// 4) stale timestamp → 400
const staleRes = await POST(req("POST", { publicKey: publicKeyB64, signature, timestamp: timestamp - 4000 }));
check("POST stale timestamp → 400", staleRes.status === 400, `status=${staleRes.status}`);

// 5) missing fields → 400
const missingRes = await POST(req("POST", { publicKey: publicKeyB64 }));
check("POST missing fields → 400", missingRes.status === 400, `status=${missingRes.status}`);

// 6) disabled (ALLOW_AGENT_AUTH unset) → 404 on both GET and POST
process.env.ALLOW_AGENT_AUTH = "";
check("disabled → GET 404", (await GET()).status === 404);
check("disabled → POST 404", (await POST(req("POST", { publicKey: publicKeyB64, signature, timestamp }))).status === 404);

console.log(failures === 0 ? "\nAGENT AUTH SELFTEST OK ✅" : `\nAGENT AUTH SELFTEST FAILED ❌ (${failures})`);
process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
