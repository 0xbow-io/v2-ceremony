"use client";

import { useState } from "react";

import type { ReceiptResponse } from "@/lib/api";
import { useCeremonyConfig } from "@/hooks/useCeremonyConfig";
import { Button } from "@/app/components/Button";
import { ScreenWrapper } from "@/app/components/ScreenWrapper";
import styles from "./VerifyScreen.module.css";

export function VerifyScreen({
  onBack,
  onVerify,
}: {
  onBack: () => void;
  onVerify: (receiptJson: string) => Promise<ReceiptResponse[]>;
}) {
  const { copy } = useCeremonyConfig();
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"idle" | "verifying" | "success" | "error">(
    "idle",
  );
  const [result, setResult] = useState<ReceiptResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleVerify = async () => {
    setStatus("verifying");
    setError(null);
    setResult(null);

    try {
      const receipts = await onVerify(input);
      setResult(receipts);
      setStatus("success");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setStatus("error");
    }
  };

  return (
    <ScreenWrapper className="screenLayout">
      <div className={styles.header}>
        <h2 className="sectionTitle">{copy.verify.title}</h2>
        <p className="sectionSubtitle">{copy.verify.subtitle}</p>
      </div>

      <div className={styles.inputGroup}>
        <label htmlFor="receipt-input" className="label">{copy.verify.label}</label>
        <textarea
          id="receipt-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={copy.verify.placeholder}
          className={`${styles.textarea} ${status === "error" ? styles.textareaError : ""}`}
          aria-invalid={status === "error"}
          aria-describedby={status === "error" ? "receipt-input-error" : undefined}
        />
      </div>

      <Button onClick={handleVerify}>
        {status === "verifying" && copy.verify.verifyingCta}
        {status !== "verifying" && copy.verify.cta}
      </Button>

      <div className="card">{copy.verify.note}</div>

      {status === "success" && result && (
        <div className="card">
          <div className={styles.resultList}>
            <div className={styles.resultTitle}>{copy.verify.successTitle}</div>
            {result.map((receipt) => (
              <div key={`${receipt.circuitId}-${receipt.contributionIndex}`}>
                <div className={styles.resultItem}>
                  {receipt.circuitId} #{receipt.contributionIndex}
                </div>
                <div className={styles.resultHash}>
                  {receipt.contributionHash}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {status === "error" && error && (
        <div
          id="receipt-input-error"
          role="alert"
          className={styles.errorCard}
        >
          <svg
            className={styles.errorIcon}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="8" cy="8" r="7" />
            <line x1="8" y1="4.5" x2="8" y2="8.5" />
            <circle cx="8" cy="11.25" r="0.5" fill="currentColor" />
          </svg>
          <div className={styles.errorBody}>
            <span className={styles.errorLabel}>{copy.verify.errorLabel}</span>
            <span>{error}</span>
          </div>
        </div>
      )}

      <Button variant="secondary" size="small" onClick={onBack}>
        {copy.verify.backCta}
      </Button>
    </ScreenWrapper>
  );
}
