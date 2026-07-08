import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

import { NextResponse } from "next/server";

import { ceremonyConfig } from "@/lib/ceremony-config";
import { signCliToken } from "@/lib/participant-auth";

/**
 * Agent / headless auth: a generated Ed25519 keypair in place of a GitHub
 * login, so an autonomous agent (e.g. `codex`) can obtain a Caburé Bearer JWT
 * with no human step, then contribute via `@wonderland/cabure-cli --token`.
 *
 * Opt-in: the operator must set ALLOW_AGENT_AUTH=1. Off (default) → 404, so a
 * ceremony that wants only GitHub-gated humans is unaffected.
 *
 * Security note: this is deliberately NOT sybil-resistant — anyone can generate
 * a keypair. That's acceptable for a Phase-2 trusted setup: extra participants
 * can only ADD entropy, never weaken the result (you'd need EVERY participant to
 * be dishonest to break it), and the README already states a participant count
 * is not evidence of N honest contributors. The signature only proves the caller
 * holds the private key for the identity it claims, giving a stable per-agent
 * participantId for dedupe + receipts.
 */

// Clock skew the signed timestamp may drift from the server, in seconds.
const CHALLENGE_WINDOW_SECONDS = 300;

function agentAuthEnabled(): boolean {
  return process.env.ALLOW_AGENT_AUTH === "1";
}

/** The exact message the agent must sign — domain-separated per ceremony. */
function challengeMessage(timestamp: number): string {
  return `cabure-agent-auth:${ceremonyConfig.slug}:${timestamp}`;
}

/**
 * Discovery: lets an agent learn the exact challenge format (slug + window)
 * without hardcoding it, then POST a signed challenge. Returns 404 when agent
 * auth is disabled so callers can detect support.
 */
export async function GET(): Promise<Response> {
  if (!agentAuthEnabled()) {
    return NextResponse.json({ error: "Agent authentication is not enabled" }, { status: 404 });
  }
  return NextResponse.json({
    scheme: "ed25519",
    slug: ceremonyConfig.slug,
    // Substitute <unix-seconds> with the current time, sign the resulting
    // string with your Ed25519 private key, then POST { publicKey, signature,
    // timestamp }. See /llms.txt for a ready-to-run snippet.
    challengeTemplate: `cabure-agent-auth:${ceremonyConfig.slug}:<unix-seconds>`,
    windowSeconds: CHALLENGE_WINDOW_SECONDS,
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!agentAuthEnabled()) {
    return NextResponse.json({ error: "Agent authentication is not enabled" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { publicKey, signature, timestamp } = (body ?? {}) as {
    publicKey?: unknown;
    signature?: unknown;
    timestamp?: unknown;
  };

  if (
    typeof publicKey !== "string" ||
    typeof signature !== "string" ||
    typeof timestamp !== "number" ||
    !Number.isFinite(timestamp)
  ) {
    return NextResponse.json(
      { error: "Expected { publicKey: base64 SPKI DER, signature: base64, timestamp: unix seconds }" },
      { status: 400 },
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > CHALLENGE_WINDOW_SECONDS) {
    return NextResponse.json(
      { error: `Timestamp outside the ${CHALLENGE_WINDOW_SECONDS}s window` },
      { status: 400 },
    );
  }

  // Verify the Ed25519 signature over the domain-separated challenge. Any
  // malformed key/signature is a rejection, not a 500.
  let valid = false;
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    if (key.asymmetricKeyType !== "ed25519") {
      return NextResponse.json({ error: "Public key must be Ed25519" }, { status: 400 });
    }
    valid = verifySignature(
      null,
      Buffer.from(challengeMessage(timestamp), "utf8"),
      key,
      Buffer.from(signature, "base64"),
    );
  } catch {
    valid = false;
  }

  if (!valid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Stable, self-owned identity derived from the public key.
  const fingerprint = createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
  const participantId = `agent:${fingerprint}`;
  const participantName = `agent-${fingerprint.slice(0, 8)}`;

  const { token, expiresAt } = signCliToken(participantId, participantName);
  return NextResponse.json({ token, participantId, participantName, expiresAt });
}
