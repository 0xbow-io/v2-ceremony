import { createHmac, timingSafeEqual } from "node:crypto";

import { getServerSession } from "next-auth";

import { authOptions } from "./auth";
import { env } from "./env";

export interface Participant {
  participantId: string;
  participantName: string;
}

interface CliTokenPayload {
  sub: string;
  name: string;
  exp: number;
}

const CLI_TOKEN_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

/**
 * Resolve the authenticated participant from a request. Checks a Bearer JWT
 * first (CLI flow — avoids a wasted session lookup), then falls back to the
 * NextAuth session (browser flow).
 */
export async function getParticipant(
  request: Request,
): Promise<Participant | null> {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const payload = verifyCliToken(authHeader.slice(7));
    if (payload) {
      return {
        participantId: payload.sub,
        participantName: payload.name,
      };
    }
  }

  const session = await getServerSession(authOptions);
  if (session?.participantId) {
    return {
      participantId: session.participantId,
      participantName: session.participantName ?? "",
    };
  }

  return null;
}

/** Sign a JWT for CLI clients using HMAC-SHA256 with NEXTAUTH_SECRET. */
export function signCliToken(participantId: string, participantName: string): {
  token: string;
  expiresAt: number;
} {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + CLI_TOKEN_EXPIRY_SECONDS;

  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");

  const payload: CliTokenPayload = { sub: participantId, name: participantName, exp };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");

  const signature = createHmac("sha256", env.NEXTAUTH_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");

  return { token: `${header}.${body}.${signature}`, expiresAt: exp };
}

function verifyCliToken(token: string): CliTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, body, sig] = parts;

  const expected = createHmac("sha256", env.NEXTAUTH_SECRET)
    .update(`${header}.${body}`)
    .digest();

  let sigBuffer: Buffer;
  try {
    sigBuffer = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }

  if (
    sigBuffer.length !== expected.length ||
    !timingSafeEqual(sigBuffer, expected)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString(),
    ) as CliTokenPayload;

    if (
      typeof payload.sub !== "string" ||
      typeof payload.exp !== "number" ||
      payload.exp < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
