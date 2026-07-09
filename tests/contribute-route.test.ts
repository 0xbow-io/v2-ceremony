import { createHash } from "node:crypto";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cryptoMocks = vi.hoisted(() => ({
  parseMpcParams: vi.fn(),
  verifyChain: vi.fn(),
}));
const configMocks = vi.hoisted(() => ({
  getCeremonyConfig: vi.fn(),
}));
const stateMocks = vi.hoisted(() => ({
  computeChainHash: vi.fn(),
  getCircuitState: vi.fn(),
  getManifest: vi.fn(),
  hasParticipantContributedToCircuit: vi.fn(),
  isCircuitActive: vi.fn(),
  kvKey: vi.fn(),
  noShowKey: vi.fn(),
  pruneExpiredEntries: vi.fn(),
  reconcileFront: vi.fn(),
  resolveMaxActiveSeconds: vi.fn(),
}));
const participantMocks = vi.hoisted(() => ({
  getParticipant: vi.fn(),
}));
const blobMocks = vi.hoisted(() => ({
  copyBinary: vi.fn(),
  deleteBinary: vi.fn(),
  putBinary: vi.fn(),
}));
const kvMocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  deleteKey: vi.fn(),
  releaseLock: vi.fn(),
  writeCircuitStateFenced: vi.fn(),
  writeContribution: vi.fn(),
}));

vi.mock("@wonderland/cabure-crypto", () => cryptoMocks);
vi.mock("@/lib/snarkjs-gc-guard", () => ({}));
vi.mock("@/lib/ceremony-config", () => configMocks);
vi.mock("@/lib/ceremony-state", () => stateMocks);
vi.mock("@/lib/participant-auth", () => participantMocks);
vi.mock("@/lib/blob-store", () => blobMocks);
vi.mock("@/lib/kv-store", () => kvMocks);
vi.mock("@/lib/external-verifier", () => ({ verifyRemote: vi.fn() }));
vi.mock("@/lib/ptau-loader", () => ({ loadPtau: vi.fn() }));

import { POST } from "@/app/api/ceremony/circuits/[id]/contribute/route";

const participantId = "github:12345";
const clientHash = `0x${"11".repeat(32)}`;
const serverHash = `0x${"22".repeat(32)}`;
const chainHash = `0x${"33".repeat(32)}`;
const pendingUrl =
  "https://store.public.blob.vercel-storage.com/contributions/deposit/pending-test.zkey";
const zkeyBytes = new Uint8Array([1, 2, 3, 4]);

function circuitState() {
  return {
    id: "deposit",
    totalContributions: 0,
    latestContributionHash: null,
    chainHash: `0x${"00".repeat(32)}`,
    queue: [{ participantId, joinedAt: Date.now(), claimedAt: Date.now() }],
    currentZkeyPath: "ceremony/zkeys/deposit/current.zkey",
    currentZkeyUrl:
      "https://store.public.blob.vercel-storage.com/ceremony/zkeys/deposit/current.zkey",
    initialZkeyHash: `0x${"44".repeat(32)}`,
    initialZkeyUrl:
      "https://store.public.blob.vercel-storage.com/ceremony/zkeys/deposit/genesis.zkey",
    ptauUrl: "https://example.com/pot.ptau",
    headContributionHash: null,
    csHash: "deposit-cs-hash",
  };
}

describe("contribution commit privacy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();

    configMocks.getCeremonyConfig.mockReturnValue({
      verifyContributions: false,
      queueTimeoutSeconds: 300,
      claimWindowSeconds: 30,
      circuits: [
        {
          id: "deposit",
          targetContributions: 500,
          constraints: "2,061",
          artifacts: {
            ptauPath: "circuits/pot.ptau",
          },
        },
      ],
      storage: {
        manifestPath: "ceremony/manifest",
        circuitStatePrefix: "ceremony/circuits",
        receiptsPath: "ceremony/receipts",
        participantContributionsPrefix: "ceremony/participants",
        participantsIndexPath: "ceremony/participant-index",
        zkeyPrefix: "ceremony/zkeys",
        noShowPrefix: "ceremony/no-shows",
      },
    });
    participantMocks.getParticipant.mockResolvedValue({
      participantId,
      participantName: "contributor",
    });
    stateMocks.getManifest.mockResolvedValue({
      ceremonyName: "ppv2-ceremony",
      targetContributions: 500,
      endDate: "2026-08-01",
      startedAt: 1_725_000_000_000,
      circuits: [{ id: "deposit" }],
    });
    stateMocks.getCircuitState.mockImplementation(async () => circuitState());
    stateMocks.hasParticipantContributedToCircuit.mockResolvedValue(false);
    stateMocks.isCircuitActive.mockReturnValue(true);
    stateMocks.pruneExpiredEntries.mockImplementation((queue: unknown[]) => queue);
    stateMocks.reconcileFront.mockImplementation((queue: unknown[]) => ({
      queue,
      evictedNoShowIds: [],
    }));
    stateMocks.resolveMaxActiveSeconds.mockReturnValue(300);
    stateMocks.kvKey.mockImplementation(
      (prefix: string, suffix: string) => `${prefix}:${suffix}`,
    );
    stateMocks.noShowKey.mockReturnValue("ceremony/no-shows:deposit:github:12345");
    stateMocks.computeChainHash.mockReturnValue(chainHash);

    cryptoMocks.parseMpcParams.mockResolvedValue({
      csHash: "deposit-cs-hash",
      contributions: [{ hash: () => serverHash }],
    });

    blobMocks.putBinary.mockImplementation(async (pathname: string) => ({
      pathname,
      url: `https://store.public.blob.vercel-storage.com/${pathname}`,
    }));
    blobMocks.deleteBinary.mockResolvedValue(undefined);
    kvMocks.acquireLock.mockResolvedValue(true);
    kvMocks.releaseLock.mockResolvedValue(undefined);
    kvMocks.writeContribution.mockResolvedValue(true);
    kvMocks.deleteKey.mockResolvedValue(undefined);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(zkeyBytes, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        }),
      ),
    );
  });

  it("commits to an opaque path and returns an owner receipt", async () => {
    const response = await POST(
      new NextRequest(
        "https://ceremony.example/api/ceremony/circuits/deposit/contribute",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            blobUrl: pendingUrl,
            contributionHash: clientHash,
          }),
        },
      ),
      { params: Promise.resolve({ id: "deposit" }) },
    );

    const committedPath = blobMocks.putBinary.mock.calls[0][0] as string;
    expect(committedPath).toMatch(
      /^ceremony\/zkeys\/deposit\/contribution-[0-9a-f-]{36}\.zkey$/,
    );
    expect(committedPath).not.toContain(participantId);

    const contributionHash = `0x${createHash("sha256")
      .update(zkeyBytes)
      .digest("hex")}`;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      circuitId: "deposit",
      contributionIndex: 1,
      contributionHash,
      serverContributionHash: serverHash,
      previousContributionHash: null,
      chainHash,
      clientContributionHash: clientHash,
    });

    expect(kvMocks.writeContribution).toHaveBeenCalledWith(
      expect.objectContaining({
        receipt: expect.objectContaining({
          participantId,
          timestamp: expect.any(Number),
        }),
        circuitState: expect.objectContaining({
          currentZkeyPath: committedPath,
        }),
      }),
    );
  });
});
