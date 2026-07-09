import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ceremonyStateMocks = vi.hoisted(() => ({
  getCircuitState: vi.fn(),
}));

vi.mock("@/lib/ceremony-state", () => ceremonyStateMocks);

import { GET } from "@/app/api/ceremony/circuits/[id]/zkey/route";

describe("zkey route cache policy", () => {
  beforeEach(() => {
    ceremonyStateMocks.getCircuitState.mockResolvedValue({
      totalContributions: 4,
      currentZkeyUrl: "https://blob.example/current.zkey",
      latestContributionHash: "0xhash",
    });
  });

  it("uses no-store for JSON responses", async () => {
    const response = await GET(
      new NextRequest("https://ceremony.example/api/ceremony/circuits/deposit/zkey?format=json"),
      { params: Promise.resolve({ id: "deposit" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("uses no-store for redirects", async () => {
    const response = await GET(
      new NextRequest("https://ceremony.example/api/ceremony/circuits/deposit/zkey"),
      { params: Promise.resolve({ id: "deposit" }) },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Contribution-Index")).toBe("5");
  });
});
