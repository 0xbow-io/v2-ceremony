import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ceremonyStateMocks = vi.hoisted(() => ({
  getReceipts: vi.fn(),
}));

vi.mock("@/lib/ceremony-state", () => ceremonyStateMocks);

import { GET } from "@/app/api/ceremony/receipt/route";

const contributionHash = `0x${"ab".repeat(32)}`;
const storedReceipt = {
  circuitId: "deposit",
  participantId: "github:12345",
  contributionIndex: 3,
  contributionHash,
  clientContributionHash: `0x${"12".repeat(32)}`,
  serverContributionHash: `0x${"34".repeat(32)}`,
  previousContributionHash: null,
  chainHash: `0x${"56".repeat(32)}`,
  timestamp: 1_725_000_000_000,
};

function request(query: string): NextRequest {
  return new NextRequest(`https://ceremony.example/api/ceremony/receipt?${query}`);
}

describe("public receipt route", () => {
  beforeEach(() => {
    ceremonyStateMocks.getReceipts.mockReset();
    ceremonyStateMocks.getReceipts.mockResolvedValue([storedReceipt]);
  });

  it.each([
    "contributionIndex=3",
    "circuitId=&contributionIndex=3",
    "circuitId=deposit",
    "circuitId=deposit&contributionIndex=3x",
    "circuitId=deposit&contributionIndex=0",
    "circuitId=deposit&contributionIndex=9007199254740992",
    "circuitId=deposit&contributionIndex=3",
    `circuitId=deposit&participantId=github%3A12345&contributionIndex=3&contributionHash=${contributionHash}`,
    "circuitId=deposit&contributionIndex=3&contributionHash=0x12",
  ])("returns 400 before reading KV for malformed input: %s", async (query) => {
    const response = await GET(request(query));

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(ceremonyStateMocks.getReceipts).not.toHaveBeenCalled();
  });

  it("returns identical 404 responses for a missing receipt and hash mismatch", async () => {
    ceremonyStateMocks.getReceipts.mockResolvedValueOnce([]);
    const missing = await GET(
      request(`circuitId=deposit&contributionIndex=3&contributionHash=${contributionHash}`),
    );
    const mismatch = await GET(
      request(
        `circuitId=deposit&contributionIndex=3&contributionHash=0x${"cd".repeat(32)}`,
      ),
    );

    expect(missing.status).toBe(404);
    expect(mismatch.status).toBe(404);
    expect(await missing.json()).toEqual(await mismatch.json());
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
    expect(mismatch.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns only public fields for a hash-bound lookup", async () => {
    const response = await GET(
      request(
        `circuitId=deposit&contributionIndex=3&contributionHash=${contributionHash}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      success: true,
      circuitId: "deposit",
      contributionIndex: 3,
      contributionHash,
      serverContributionHash: storedReceipt.serverContributionHash,
      previousContributionHash: null,
      chainHash: storedReceipt.chainHash,
    });
  });
});
