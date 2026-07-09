"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Header } from "./components/Header";
import { LandingScreen } from "./screens/LandingScreen";
import { EntropyScreen } from "./screens/EntropyScreen";
import { TierScreen } from "./screens/TierScreen";
import { ProgressScreen } from "./screens/ProgressScreen";
import { CompleteScreen } from "./screens/CompleteScreen";
import { VerifyScreen } from "./screens/VerifyScreen";

import { getReceipt } from "@/lib/api";
import { parseReceiptInput } from "@/lib/receipt-parser";
import { type CeremonyStep, type TierId } from "@/lib/ceremony-config";
import { useCeremonyConfig } from "@/hooks/useCeremonyConfig";
import { useCeremonyStatus } from "@/hooks/useCeremonyStatus";
import { useParticipant } from "@/hooks/useParticipant";
import { useContributionFlow } from "@/hooks/useContributionFlow";
import { formatTemplate } from "@/utils/format";
import styles from "./page.module.css";

export default function CeremonyPage() {
  const config = useCeremonyConfig();
  const [step, setStep] = useState<CeremonyStep>("landing");
  const [entropySeed, setEntropySeed] = useState<Uint8Array | null>(null);
  const tiers = config.tiers ?? [];
  const tiersEnabled = config.tiersEnabled ?? false;
  const [selectedTier, setSelectedTier] = useState<TierId>(
    tiers[0]?.id ?? "core",
  );
  const [isJoining, setIsJoining] = useState(false);
  const joiningRef = useRef(false);

  const { status, statusError } = useCeremonyStatus();
  const { authenticate } = useParticipant();

  const selectedCircuitIds = useMemo(() => {
    if (!tiersEnabled) {
      return config.circuits.map((circuit) => circuit.id);
    }
    const tier = tiers.find((item) => item.id === selectedTier);
    return tier
      ? tier.circuitIds
      : config.circuits.map((circuit) => circuit.id);
  }, [selectedTier, tiersEnabled, tiers]);

  const contribution = useContributionFlow({
    entropySeed,
    selectedCircuitIds,
    circuits: config.circuits,
    active: step === "progress",
  });

  // Auto-advance to the Complete screen the moment the last contribution
  // finishes. The user should not have to click through: by the time the flow
  // is finalizeReady all the compute is already done, and the receipts +
  // attestation options live on Complete — a missed click would strand them.
  useEffect(() => {
    if (step === "progress" && contribution.finalizeReady) {
      setStep("complete");
    }
  }, [step, contribution.finalizeReady]);

  // Guard against accidentally closing/navigating away mid-contribution. A run
  // takes 30–60 minutes and lives entirely in this tab, so a stray ⌘W or back
  // gesture would throw away all progress. The native prompt only fires while a
  // contribution is actually in progress.
  useEffect(() => {
    if (step !== "progress") return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [step]);

  const handleAuth = (method: "github") => {
    if (status && !status.isActive) return;
    authenticate(method);
  };

  const handleBeginContribution = () => {
    setStep("entropy");
  };

  const handleEntropyComplete = (seed: Uint8Array) => {
    setEntropySeed(seed);
    if (tiersEnabled) {
      setStep("tier");
    } else {
      void handleJoinQueue();
    }
  };

  const handleJoinQueue = async () => {
    if (joiningRef.current) return;
    joiningRef.current = true;
    setIsJoining(true);
    try {
      const joinOptions = tiersEnabled
        ? { tierId: selectedTier }
        : { circuitIds: selectedCircuitIds };
      await contribution.joinAndStart(joinOptions, config.circuits);
      setStep("progress");
    } catch (error) {
      /* queue error is tracked inside the hook */
    } finally {
      joiningRef.current = false;
      setIsJoining(false);
    }
  };

  const handleCancelContribution = () => {
    contribution.cancel();
    entropySeed?.fill(0);
    setEntropySeed(null);
    setStep("landing");
  };

  const handleVerifyReceipt = async (input: string) => {
    const receiptList = parseReceiptInput(input, {
      invalidReceipt: config.copy.verify.invalidReceipt,
      duplicateReceipt: config.copy.verify.duplicateReceipt,
    });

    return await Promise.all(
      receiptList.map(async (receipt) => {
        const stored = await getReceipt({
          circuitId: receipt.circuitId,
          contributionIndex: receipt.contributionIndex,
          contributionHash: receipt.contributionHash,
        });
        if (
          receipt.contributionHash.toLowerCase() !==
          stored.contributionHash.toLowerCase()
        ) {
          throw new Error(
            formatTemplate(config.copy.verify.hashMismatch, {
              circuitId: receipt.circuitId,
              contributionIndex: String(receipt.contributionIndex),
            }),
          );
        }
        return stored;
      }),
    );
  };

  const isFullScreen = step === "entropy";

  return (
    <div className={styles.page}>
      <div className={styles.content}>
        {!isFullScreen && (
          <Header
            step={step}
            onLogoClick={step === "progress" ? handleCancelContribution : () => setStep("landing")}
          />
        )}

        {isFullScreen && (
          <EntropyScreen onComplete={handleEntropyComplete} />
        )}

        {!isFullScreen && (
          <main className={styles.main}>
            {step === "landing" && !status && (
              <div className={styles.loader}>
                <div className={styles.spinner} />
                <p className={styles.loaderText}>Loading ceremony...</p>
              </div>
            )}

            {step === "landing" && status && (
              <LandingScreen
                onAuth={handleAuth}
                onBegin={handleBeginContribution}
                onVerify={() => setStep("verify")}
              />
            )}

            {step === "tier" && tiersEnabled && (
              <TierScreen
                selectedTier={selectedTier}
                onSelectTier={setSelectedTier}
                onNext={handleJoinQueue}
                isJoining={isJoining}
              />
            )}

            {step === "progress" && (
              <ProgressScreen
                circuits={contribution.circuitRuns}
                activeCircuit={
                  contribution.currentCircuit && !contribution.finalizeReady
                    ? {
                        id: contribution.currentCircuit.id,
                        label: contribution.currentCircuit.label,
                        constraints: contribution.currentCircuit.constraints,
                        index: contribution.currentCircuitIndex,
                        count: contribution.circuitRuns.length,
                      }
                    : null
                }
                phase={contribution.contributionPhase}
                progress={contribution.contributionProgress}
                etaSecondsRemaining={contribution.estimatedSecondsRemaining}
                error={contribution.contributionError ?? contribution.queueError}
                autoRetrying={contribution.autoRetrying}
                autoRetryMessage={contribution.autoRetryMessage}
                autoRetryAttempt={contribution.autoRetryAttempt}
                autoRetryMax={contribution.autoRetryMax}
                onRetry={contribution.retry}
                onCancel={handleCancelContribution}
              />
            )}

            {step === "complete" && (
              <CompleteScreen
                receipts={contribution.receipts}
                onVerify={() => setStep("verify")}
              />
            )}

            {step === "verify" && (
              <VerifyScreen
                onBack={() => setStep("landing")}
                onVerify={handleVerifyReceipt}
              />
            )}

            {statusError && (
              <div className={`card ${styles.statusError}`}>
                {statusError}
              </div>
            )}
          </main>
        )}
      </div>
    </div>
  );
}
