import type { Groth16VerificationKey } from "@wonderland/cabure-crypto";

import {
  toPublicReceipt,
  type PublicReceiptSource,
} from "./public-receipt";

export interface FinalCircuitSummary {
  circuitId: string;
  totalContributions: number;
  finalChainHash: string;
  finalContributionHash: string;
  finalZkeyHash: string;
  finalZkeyPath: string;
  verificationKey: Groth16VerificationKey;
}

export function buildFinalTranscript(options: {
  name: string;
  targetContributions: number;
  startedAt: number;
  endDate: string | null;
  beaconHash: string;
  beaconSource: string;
  beaconSlot?: number;
  finalizedAt: number;
  circuits: readonly FinalCircuitSummary[];
  storedReceipts: readonly PublicReceiptSource[];
}) {
  return {
    ceremony: {
      name: options.name,
      targetContributions: options.targetContributions,
      startedAt: options.startedAt,
      endDate: options.endDate,
      beaconHash: options.beaconHash,
      beaconSource: options.beaconSource,
      ...(options.beaconSlot !== undefined && {
        beaconSlot: options.beaconSlot,
      }),
      finalizedAt: options.finalizedAt,
    },
    circuits: options.circuits,
    receipts: options.storedReceipts.map(toPublicReceipt),
  };
}
