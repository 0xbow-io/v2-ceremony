import { afterEach, describe, expect, it, vi } from "vitest";

import { getReceipt } from "@/lib/api";

describe("browser receipt API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires and sends the contribution hash without a participant ID", async () => {
    const contributionHash = `0x${"ab".repeat(32)}`;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          circuitId: "deposit",
          contributionIndex: 3,
          contributionHash,
          serverContributionHash: `0x${"cd".repeat(32)}`,
          previousContributionHash: null,
          chainHash: `0x${"ef".repeat(32)}`,
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getReceipt({
      circuitId: "deposit",
      contributionIndex: 3,
      contributionHash,
    });

    const requestedUrl = new URL(
      fetchMock.mock.calls[0][0],
      "https://ceremony.example",
    );
    expect(requestedUrl.searchParams.get("circuitId")).toBe("deposit");
    expect(requestedUrl.searchParams.get("contributionIndex")).toBe("3");
    expect(requestedUrl.searchParams.get("contributionHash")).toBe(
      contributionHash,
    );
    expect(requestedUrl.searchParams.has("participantId")).toBe(false);
  });
});
