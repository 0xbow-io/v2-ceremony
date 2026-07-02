"use client";

import { useState } from "react";
import type { ReceiptResponse } from "@/lib/api";
import { formatTemplate } from "@/utils/format";

export function useReceiptActions(options: {
  receipts: ReceiptResponse[];
  ceremonyName: string;
  receiptFilename: string;
  shareTemplate: string;
}) {
  const { receipts, ceremonyName, receiptFilename, shareTemplate } = options;
  const [copied, setCopied] = useState(false);

  const latestReceipt = receipts[receipts.length - 1];
  const receiptPayload =
    receipts.length > 0 ? JSON.stringify(receipts, null, 2) : "";

  const handleCopy = async () => {
    if (!receiptPayload) return;
    try {
      await navigator.clipboard.writeText(receiptPayload);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard write can fail in insecure contexts */
    }
  };

  const handleCopyItem = (hash: string) => {
    navigator.clipboard.writeText(hash);
  };

  const handleDownload = () => {
    if (!receiptPayload) return;
    const blob = new Blob([receiptPayload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = receiptFilename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleShare = () => {
    if (!latestReceipt) return;
    const text = formatTemplate(shareTemplate, {
      ceremonyName,
      circuitId: latestReceipt.circuitId,
      contributionIndex: String(latestReceipt.contributionIndex),
    });
    const ceremonyUrl = window.location.origin;
    const intentUrl =
      `https://x.com/intent/tweet` +
      `?text=${encodeURIComponent(text)}` +
      `&url=${encodeURIComponent(ceremonyUrl)}`;
    window.open(intentUrl, "_blank", "noopener,noreferrer");
  };

  return {
    receiptPayload,
    latestReceipt,
    copied,
    handleCopy,
    handleCopyItem,
    handleDownload,
    handleShare,
  };
}
