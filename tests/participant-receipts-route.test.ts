import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ceremonyStateMocks = vi.hoisted(() => ({
  getReceipts: vi.fn(),
}));
const participantMocks = vi.hoisted(() => ({
  getParticipant: vi.fn(),
}));

vi.mock("@/lib/ceremony-state", () => ceremonyStateMocks);
vi.mock("@/lib/participant-auth", () => participantMocks);

import { GET } from "@/app/api/ceremony/participant/receipts/route";

const storedReceipt = {
  circuitId: "deposit",
  participantId: "github:12345",
  contributionIndex: 3,
  contributionHash: `0x${"11".repeat(32)}`,
  clientContributionHash: `0x${"22".repeat(32)}`,
  serverContributionHash: `0x${"33".repeat(32)}`,
  previousContributionHash: null,
  chainHash: `0x${"44".repeat(32)}`,
  timestamp: 1_725_000_000_000,
};

describe("participant receipt route", () => {
  beforeEach(() => {
    ceremonyStateMocks.getReceipts.mockReset();
    participantMocks.getParticipant.mockReset();
    participantMocks.getParticipant.mockResolvedValue({
      participantId: storedReceipt.participantId,
      participantName: "contributor",
    });
    ceremonyStateMocks.getReceipts.mockResolvedValue([storedReceipt]);
  });

  it("returns owner projections instead of stored receipt records", async () => {
    const response = await GET(
      new NextRequest("https://ceremony.example/api/ceremony/participant/receipts"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      receipts: [
        {
          success: true,
          circuitId: storedReceipt.circuitId,
          contributionIndex: storedReceipt.contributionIndex,
          contributionHash: storedReceipt.contributionHash,
          serverContributionHash: storedReceipt.serverContributionHash,
          previousContributionHash: null,
          chainHash: storedReceipt.chainHash,
          clientContributionHash: storedReceipt.clientContributionHash,
        },
      ],
    });
  });
});
