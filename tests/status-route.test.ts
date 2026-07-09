import { beforeEach, describe, expect, it, vi } from "vitest";

const ceremonyStateMocks = vi.hoisted(() => ({
  getAllCircuitStates: vi.fn(),
  getManifest: vi.fn(),
  isCeremonyActive: vi.fn(),
}));
const configMocks = vi.hoisted(() => ({
  getCeremonyConfig: vi.fn(),
}));

vi.mock("@/lib/ceremony-state", () => ceremonyStateMocks);
vi.mock("@/lib/ceremony-config", () => configMocks);

import { GET } from "@/app/api/ceremony/status/route";

describe("ceremony status privacy sentinel", () => {
  beforeEach(() => {
    configMocks.getCeremonyConfig.mockReturnValue({
      circuits: [
        { id: "occupied", targetContributions: 2 },
        { id: "empty", targetContributions: 3 },
      ],
    });
    ceremonyStateMocks.getManifest.mockResolvedValue({
      endDate: "2026-08-01",
      startedAt: 1_725_000_000_000,
    });
    ceremonyStateMocks.getAllCircuitStates.mockResolvedValue([
      {
        id: "occupied",
        totalContributions: 1,
        queue: [{ participantId: "github:private-user", joinedAt: 1 }],
        latestContributionHash: "0xoccupied",
        chainHash: "0xchain1",
      },
      {
        id: "empty",
        totalContributions: 2,
        queue: [],
        latestContributionHash: "0xempty",
        chainHash: "0xchain2",
      },
    ]);
    ceremonyStateMocks.isCeremonyActive.mockReturnValue(true);
  });

  it("returns active or null without changing aggregates or cache policy", async () => {
    const response = await GET();
    const body = await response.json();

    expect(body).toEqual({
      isActive: true,
      totalContributions: 3,
      targetContributions: 5,
      endDate: "2026-08-01",
      startedAt: 1_725_000_000_000,
      beaconApplied: false,
      beaconHash: null,
      finalizedAt: null,
      circuits: [
        {
          circuitId: "occupied",
          targetContributions: 2,
          totalContributions: 1,
          currentParticipant: "active",
          queueLength: 1,
          latestContributionHash: "0xoccupied",
          chainHash: "0xchain1",
          isComplete: false,
        },
        {
          circuitId: "empty",
          targetContributions: 3,
          totalContributions: 2,
          currentParticipant: null,
          queueLength: 0,
          latestContributionHash: "0xempty",
          chainHash: "0xchain2",
          isComplete: false,
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("github:private-user");
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=0, s-maxage=5, stale-while-revalidate=30",
    );
  });
});
