import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";

import { env } from "@/lib/env";

// Publish a contributor's attestation Gist server-side. The GitHub access token
// lives only in the encrypted, httpOnly session JWT — read here via getToken,
// never exposed to client JavaScript. This keeps a write-scoped token off the
// page, so an XSS cannot steal it. Browser flow only: the CLI holds a Caburé
// JWT (no GitHub token) and publishes its attestation manually.

// The attestation is tiny JSON; cap the content so this route cannot be used to
// create large Gists with the operator's app token.
const MAX_CONTENT_BYTES = 16 * 1024;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = await getToken({
    req: request,
    secret: env.NEXTAUTH_SECRET,
  });
  const accessToken = token?.accessToken;
  if (!accessToken) {
    return NextResponse.json(
      { error: "Sign in with GitHub (granting Gist access) to publish." },
      { status: 401 },
    );
  }

  let body: { filename?: unknown; content?: unknown; description?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { filename, content, description } = body;
  if (
    typeof filename !== "string" ||
    typeof content !== "string" ||
    typeof description !== "string" ||
    filename.length === 0 ||
    content.length === 0
  ) {
    return NextResponse.json(
      { error: "filename, content and description are required" },
      { status: 400 },
    );
  }
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    return NextResponse.json({ error: "Attestation too large" }, { status: 400 });
  }

  let response: Response;
  try {
    response = await fetch("https://api.github.com/gists", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        description,
        public: true,
        files: { [filename]: { content } },
      }),
      // Fail fast on a stalled upstream instead of holding the request (and the
      // client's "Publishing…" state) open indefinitely. Trips the catch below.
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Network-layer failure (DNS, timeout, connection reset). Return a
    // controlled error instead of letting it surface as a raw 500.
    return NextResponse.json(
      { error: "Could not reach GitHub to publish the Gist." },
      { status: 502 },
    );
  }

  if (!response.ok) {
    return NextResponse.json(
      { error: `GitHub rejected the Gist (${response.status}).` },
      { status: 502 },
    );
  }

  const data = (await response.json()) as { html_url?: string };
  if (!data.html_url) {
    return NextResponse.json(
      { error: "Gist created but GitHub returned no URL." },
      { status: 502 },
    );
  }
  return NextResponse.json({ url: data.html_url });
}
