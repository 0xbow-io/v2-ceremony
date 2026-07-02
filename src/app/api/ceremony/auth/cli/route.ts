import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

import { env } from "@/lib/env";
import { acquireLock, getJson, releaseLock, setJson } from "@/lib/kv-store";
import { signCliToken } from "@/lib/participant-auth";
import { cliLoginKey, type PendingDeviceAuth } from "@/lib/cli-auth";

const LOGIN_TTL_SECONDS = 900;
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

/**
 * POST /api/ceremony/auth/cli
 *
 * Initiates the GitHub OAuth device flow (RFC 8628). The server proxies
 * the request so the CLI never needs the client ID or secret.
 * Returns a user code for the participant to enter at github.com/login/device.
 */
export async function POST(): Promise<NextResponse> {
  const deviceResponse = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      scope: "read:user",
    }),
  });

  if (!deviceResponse.ok) {
    return NextResponse.json(
      { error: "Failed to initiate GitHub device flow" },
      { status: 502 },
    );
  }

  const deviceData = (await deviceResponse.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  };

  if (deviceData.error || !deviceData.device_code || !deviceData.user_code) {
    return NextResponse.json(
      {
        error:
          deviceData.error_description ??
          "GitHub device flow initiation failed. Is the Device Flow enabled in your OAuth App settings?",
      },
      { status: 400 },
    );
  }

  const loginCode = randomBytes(16).toString("hex");

  await setJson(
    cliLoginKey(loginCode),
    {
      deviceCode: deviceData.device_code,
      interval: deviceData.interval ?? 5,
      createdAt: Date.now(),
    } satisfies PendingDeviceAuth,
    LOGIN_TTL_SECONDS,
  );

  return NextResponse.json({
    userCode: deviceData.user_code,
    verificationUri: deviceData.verification_uri,
    loginCode,
    interval: deviceData.interval ?? 5,
    expiresIn: deviceData.expires_in ?? 900,
  });
}

/**
 * GET /api/ceremony/auth/cli?code=LOGIN_CODE
 *
 * Poll endpoint. The CLI calls this at the interval returned by POST.
 * The server checks GitHub's token endpoint with the stored device_code.
 * Returns 202 while pending, or the signed CLI JWT once authorized.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.json(
      { error: "code query parameter is required" },
      { status: 400 },
    );
  }

  const pending = await getJson<PendingDeviceAuth>(cliLoginKey(code));
  if (!pending) {
    return NextResponse.json(
      { error: "Invalid or expired login code" },
      { status: 404 },
    );
  }

  if (pending.completedToken) {
    return NextResponse.json({
      token: pending.completedToken,
      participantId: pending.completedParticipantId,
      participantName: pending.completedParticipantName,
      expiresAt: pending.completedExpiresAt,
    });
  }

  const lockKey = `cli-login-lock:${code}`;
  const lockToken = randomBytes(16).toString("hex");
  const locked = await acquireLock(lockKey, lockToken);

  if (!locked) {
    return NextResponse.json(
      { status: "pending", interval: pending.interval },
      { status: 202 },
    );
  }

  try {
    // Re-read after acquiring lock to see updates from a prior holder.
    const fresh = await getJson<PendingDeviceAuth>(cliLoginKey(code));
    if (!fresh) {
      return NextResponse.json(
        { error: "Invalid or expired login code" },
        { status: 404 },
      );
    }

    if (fresh.completedToken) {
      return NextResponse.json({
        token: fresh.completedToken,
        participantId: fresh.completedParticipantId,
        participantName: fresh.completedParticipantName,
        expiresAt: fresh.completedExpiresAt,
      });
    }

    const now = Date.now();
    const lastPoll = fresh.lastPolledAt ?? fresh.createdAt;
    const elapsedSeconds = (now - lastPoll) / 1000;

    if (elapsedSeconds < fresh.interval) {
      return NextResponse.json(
        { status: "pending", interval: fresh.interval },
        { status: 202 },
      );
    }

    await setJson(
      cliLoginKey(code),
      { ...fresh, lastPolledAt: now } satisfies PendingDeviceAuth,
      LOGIN_TTL_SECONDS,
    );

    const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        device_code: fresh.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    if (!tokenResponse.ok) {
      return NextResponse.json(
        { error: "GitHub token exchange failed" },
        { status: 502 },
      );
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (tokenData.error === "authorization_pending") {
      return NextResponse.json({ status: "pending" }, { status: 202 });
    }

    if (tokenData.error === "slow_down") {
      const increased = fresh.interval + 5;
      await setJson(
        cliLoginKey(code),
        { ...fresh, interval: increased, lastPolledAt: now } satisfies PendingDeviceAuth,
        LOGIN_TTL_SECONDS,
      );
      return NextResponse.json(
        { status: "pending", interval: increased },
        { status: 202 },
      );
    }

    if (tokenData.error || !tokenData.access_token) {
      return NextResponse.json(
        {
          error:
            tokenData.error_description ??
            tokenData.error ??
            "GitHub authorization failed",
        },
        { status: 400 },
      );
    }

    const userResponse = await fetch(GITHUB_USER_URL, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!userResponse.ok) {
      return NextResponse.json(
        { error: "Failed to fetch GitHub user profile" },
        { status: 502 },
      );
    }

    const user = (await userResponse.json()) as {
      id?: number;
      login?: string;
      name?: string;
    };

    if (!user.id) {
      return NextResponse.json(
        { error: "Invalid GitHub user profile" },
        { status: 502 },
      );
    }

    const participantId = `github:${user.id}`;
    const participantName = user.login ?? user.name ?? "";
    const { token, expiresAt } = signCliToken(participantId, participantName);

    await setJson(
      cliLoginKey(code),
      {
        ...fresh,
        completedToken: token,
        completedParticipantId: participantId,
        completedParticipantName: participantName,
        completedExpiresAt: expiresAt,
      } satisfies PendingDeviceAuth,
      LOGIN_TTL_SECONDS,
    );

    return NextResponse.json({
      token,
      participantId,
      participantName,
      expiresAt,
    });
  } finally {
    try {
      await releaseLock(lockKey, lockToken);
    } catch {
      // Lock TTL will expire; don't override the already-computed response.
    }
  }
}
