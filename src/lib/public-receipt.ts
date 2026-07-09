export interface PublicReceipt {
  circuitId: string;
  contributionIndex: number;
  contributionHash: string;
  serverContributionHash: string;
  previousContributionHash: string | null;
  chainHash: string;
}

export interface OwnerReceipt extends PublicReceipt {
  clientContributionHash: string | null;
}

export type PublicReceiptSource = PublicReceipt & {
  clientContributionHash?: string | null;
};

export function toPublicReceipt(
  receipt: PublicReceiptSource,
): PublicReceipt {
  return {
    circuitId: receipt.circuitId,
    contributionIndex: receipt.contributionIndex,
    contributionHash: receipt.contributionHash,
    serverContributionHash: receipt.serverContributionHash,
    previousContributionHash: receipt.previousContributionHash,
    chainHash: receipt.chainHash,
  };
}

export function toOwnerReceipt(
  receipt: PublicReceiptSource,
  clientHashOverride?: string | null,
): OwnerReceipt {
  return {
    ...toPublicReceipt(receipt),
    clientContributionHash:
      clientHashOverride !== undefined
        ? clientHashOverride
        : (receipt.clientContributionHash ?? null),
  };
}

export function serializeOwnerReceipts<TReceipt extends PublicReceiptSource>(
  receipts: readonly TReceipt[],
  clientHashFor?: (receipt: TReceipt) => string | null | undefined,
): string {
  return JSON.stringify(
    receipts.map((receipt) =>
      toOwnerReceipt(receipt, clientHashFor?.(receipt)),
    ),
    null,
    2,
  );
}
