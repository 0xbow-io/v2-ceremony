import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";

export async function middleware(request: NextRequest): Promise<NextResponse> {
  // Bearer tokens bypass the NextAuth session check here; the actual JWT
  // validation happens in getParticipant() inside each route handler.
  if (request.headers.get("authorization")?.startsWith("Bearer ")) {
    return NextResponse.next();
  }

  const token = await getToken({ req: request });
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/api/ceremony/queue",
    "/api/ceremony/participant/:path*",
    "/api/ceremony/circuits/:path*/contribute",
    "/api/ceremony/circuits/:path*/upload",
  ],
};
