import { NextRequest, NextResponse } from "next/server";
import { getCircuitState } from "@/lib/ceremony-state";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const circuit = await getCircuitState(id);
  const nextIndex = circuit.totalContributions + 1;

  if (request.nextUrl.searchParams.get("format") === "json") {
    return NextResponse.json({
      url: circuit.currentZkeyUrl,
      contributionIndex: nextIndex,
      hash: circuit.latestContributionHash ?? null,
    });
  }

  const response = NextResponse.redirect(circuit.currentZkeyUrl, 307);
  response.headers.set("X-Contribution-Index", String(nextIndex));
  return response;
}
