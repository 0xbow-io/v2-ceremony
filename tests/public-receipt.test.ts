import { describe, expect, it } from "vitest";
import type { Groth16VerificationKey } from "@wonderland/cabure-crypto";

import { buildFinalTranscript } from "@/lib/final-transcript";
import {
  serializeOwnerReceipts,
  toOwnerReceipt,
  toPublicReceipt,
} from "@/lib/public-receipt";
import { parseReceiptInput } from "@/lib/receipt-parser";

const storedReceipt = {
  circuitId: "deposit",
  participantId: "github:12345",
  contributionIndex: 7,
  contributionHash: `0x${"11".repeat(32)}`,
  clientContributionHash: `0x${"22".repeat(32)}`,
  serverContributionHash: `0x${"33".repeat(32)}`,
  previousContributionHash: `0x${"44".repeat(32)}`,
  chainHash: `0x${"55".repeat(32)}`,
  timestamp: 1_725_000_000_000,
  clientHk: `0x${"66".repeat(32)}`,
};

const publicFields = {
  circuitId: storedReceipt.circuitId,
  contributionIndex: storedReceipt.contributionIndex,
  contributionHash: storedReceipt.contributionHash,
  serverContributionHash: storedReceipt.serverContributionHash,
  previousContributionHash: storedReceipt.previousContributionHash,
  chainHash: storedReceipt.chainHash,
};

describe("receipt projections", () => {
  it("constructs the exact public allowlist", () => {
    expect(toPublicReceipt(storedReceipt)).toEqual(publicFields);
  });

  it("serializes the browser-computed client hash in live owner exports", () => {
    const payload = serializeOwnerReceipts(
      [storedReceipt],
      (receipt) => receipt.clientHk,
    );

    expect(JSON.parse(payload)).toEqual([
      {
        ...publicFields,
        clientContributionHash: storedReceipt.clientHk,
      },
    ]);
  });

  it("serializes the stored client hash in later owner downloads", () => {
    expect(JSON.parse(serializeOwnerReceipts([storedReceipt]))).toEqual([
      {
        ...publicFields,
        clientContributionHash: storedReceipt.clientContributionHash,
      },
    ]);
  });

  it("builds the final transcript with only public receipt fields", () => {
    const storedReceipts = [{ ...storedReceipt }];
    const circuits = [
      {
        circuitId: "deposit",
        totalContributions: 1,
        finalChainHash: storedReceipt.chainHash,
        finalContributionHash: `0x${"77".repeat(32)}`,
        finalZkeyHash: `0x${"88".repeat(32)}`,
        finalZkeyPath: "public/finalize/deposit.final.zkey",
        verificationKey: {} as Groth16VerificationKey,
      },
    ];

    const transcript = buildFinalTranscript({
      name: "ppv2-ceremony",
      targetContributions: 500,
      startedAt: 1_724_000_000_000,
      endDate: "2026-08-01",
      beaconHash: `0x${"99".repeat(32)}`,
      beaconSource: "test beacon",
      beaconSlot: 123,
      finalizedAt: 1_726_000_000_000,
      circuits,
      storedReceipts,
    });

    expect(transcript).toEqual({
      ceremony: {
        name: "ppv2-ceremony",
        targetContributions: 500,
        startedAt: 1_724_000_000_000,
        endDate: "2026-08-01",
        beaconHash: `0x${"99".repeat(32)}`,
        beaconSource: "test beacon",
        beaconSlot: 123,
        finalizedAt: 1_726_000_000_000,
      },
      circuits,
      receipts: [publicFields],
    });
    expect(storedReceipts[0]).toEqual(storedReceipt);
  });
});

describe("receipt parser", () => {
  const errors = {
    invalidReceipt: "invalid receipt",
    duplicateReceipt: "duplicate receipt",
  };

  it.each([
    ["old full", storedReceipt],
    ["owner", toOwnerReceipt(storedReceipt)],
    ["public", toPublicReceipt(storedReceipt)],
  ])("accepts the %s receipt format", (_label, receipt) => {
    expect(parseReceiptInput(JSON.stringify(receipt), errors)).toEqual([
      {
        circuitId: storedReceipt.circuitId,
        contributionIndex: storedReceipt.contributionIndex,
        contributionHash: storedReceipt.contributionHash,
      },
    ]);
  });
});
