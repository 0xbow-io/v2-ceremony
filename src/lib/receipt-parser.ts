export interface ReceiptLookup {
  circuitId: string;
  contributionIndex: number;
  contributionHash: string;
}

interface ReceiptParserErrors {
  invalidReceipt: string;
  duplicateReceipt: string;
}

export function parseReceiptInput(
  input: string,
  errors: ReceiptParserErrors,
): ReceiptLookup[] {
  const parsed: unknown = JSON.parse(input);
  const receiptList = Array.isArray(parsed) ? parsed : [parsed];

  if (receiptList.length === 0) {
    throw new Error(errors.invalidReceipt);
  }

  const normalized = receiptList.map((value) => {
    if (!isReceiptLookup(value)) {
      throw new Error(errors.invalidReceipt);
    }
    return {
      circuitId: value.circuitId,
      contributionIndex: value.contributionIndex,
      contributionHash: value.contributionHash,
    };
  });

  const seen = new Set<string>();
  for (const receipt of normalized) {
    const key = `${receipt.circuitId}#${receipt.contributionIndex}`;
    if (seen.has(key)) {
      throw new Error(errors.duplicateReceipt);
    }
    seen.add(key);
  }

  return normalized;
}

function isReceiptLookup(value: unknown): value is ReceiptLookup {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const receipt = value as Record<string, unknown>;
  return (
    typeof receipt.circuitId === "string" &&
    receipt.circuitId.length > 0 &&
    typeof receipt.contributionIndex === "number" &&
    Number.isSafeInteger(receipt.contributionIndex) &&
    receipt.contributionIndex > 0 &&
    typeof receipt.contributionHash === "string" &&
    receipt.contributionHash.length > 0
  );
}
