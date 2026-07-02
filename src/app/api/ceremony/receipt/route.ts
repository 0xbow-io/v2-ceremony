import { NextRequest, NextResponse } from "next/server";

import { getReceipts } from "@/lib/ceremony-state";

export async function GET(request: NextRequest) {
  const circuitId = request.nextUrl.searchParams.get("circuitId");
  const participantId = request.nextUrl.searchParams.get("participantId");
  const indexRaw = request.nextUrl.searchParams.get("contributionIndex");
  const hashRaw = request.nextUrl.searchParams.get("contributionHash");

  if (!circuitId || !participantId || !indexRaw) {
    return NextResponse.json(
      { error: "circuitId, participantId, and contributionIndex are required" },
      { status: 400 },
    );
  }

  if (!/^\d+$/.test(indexRaw)) {
    return NextResponse.json(
      { error: "contributionIndex must be a positive integer" },
      { status: 400 },
    );
  }
  const contributionIndex = Number.parseInt(indexRaw, 10);
  if (contributionIndex <= 0) {
    return NextResponse.json(
      { error: "contributionIndex must be a positive integer" },
      { status: 400 },
    );
  }

  if (hashRaw !== null && !/^0x[0-9a-fA-F]+$/.test(hashRaw)) {
    return NextResponse.json(
      { error: "contributionHash must be a hex string prefixed with 0x" },
      { status: 400 },
    );
  }

  const receipts = await getReceipts();
  const receipt = receipts.find(
    (item) =>
      item.circuitId === circuitId &&
      item.participantId === participantId &&
      item.contributionIndex === contributionIndex,
  );

  if (!receipt) {
    return NextResponse.json({ error: "Receipt not found" }, { status: 404 });
  }

  if (
    hashRaw !== null &&
    hashRaw.toLowerCase() !== receipt.contributionHash.toLowerCase()
  ) {
    return NextResponse.json(
      { error: "Hash mismatch for the requested receipt" },
      { status: 400 },
    );
  }

  return NextResponse.json({
    success: true,
    ...receipt,
  });
}
