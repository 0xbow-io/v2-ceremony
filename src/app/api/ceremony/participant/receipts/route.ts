import { NextRequest, NextResponse } from "next/server";

import { getReceipts } from "@/lib/ceremony-state";
import { getParticipant } from "@/lib/participant-auth";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const participant = await getParticipant(request);
  if (!participant) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const allReceipts = await getReceipts();
  const receipts = allReceipts
    .filter((receipt) => receipt.participantId === participant.participantId)
    .map((receipt) => ({ success: true as const, ...receipt }));

  return NextResponse.json({
    participantId: participant.participantId,
    receipts,
  });
}
