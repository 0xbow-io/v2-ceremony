import { NextRequest, NextResponse } from "next/server";

import { getReceipts } from "@/lib/ceremony-state";
import { toPublicReceipt } from "@/lib/public-receipt";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: NO_STORE_HEADERS,
  });
}

function notFound(): NextResponse {
  return json({ error: "Receipt not found" }, 404);
}

export async function GET(request: NextRequest) {
  const circuitId = request.nextUrl.searchParams.get("circuitId");
  const indexRaw = request.nextUrl.searchParams.get("contributionIndex");
  const hashRaw = request.nextUrl.searchParams.get("contributionHash");

  if (request.nextUrl.searchParams.has("participantId")) {
    return json({ error: "participantId is not accepted" }, 400);
  }

  if (!circuitId?.trim()) {
    return json({ error: "circuitId is required" }, 400);
  }

  if (indexRaw === null || !/^\d+$/.test(indexRaw)) {
    return json({ error: "contributionIndex must be a positive integer" }, 400);
  }
  const contributionIndex = Number(indexRaw);
  if (!Number.isSafeInteger(contributionIndex) || contributionIndex <= 0) {
    return json({ error: "contributionIndex must be a positive integer" }, 400);
  }

  if (hashRaw === null || !/^0x[0-9a-fA-F]{64}$/.test(hashRaw)) {
    return json(
      {
        error:
          "contributionHash is required and must be 0x followed by 64 hexadecimal characters",
      },
      400,
    );
  }

  const receipts = await getReceipts();
  const receipt = receipts.find(
    (item) =>
      item.circuitId === circuitId &&
      item.contributionIndex === contributionIndex,
  );

  if (!receipt) {
    return notFound();
  }

  if (hashRaw.toLowerCase() !== receipt.contributionHash.toLowerCase()) {
    return notFound();
  }

  return json({
    success: true,
    ...toPublicReceipt(receipt),
  });
}
