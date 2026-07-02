"use client";

import { useMemo, useRef, useState } from "react";

import { Header } from "./components/Header";
import { LandingScreen } from "./screens/LandingScreen";
import { EntropyScreen } from "./screens/EntropyScreen";
import { TierScreen } from "./screens/TierScreen";
import { ProgressScreen } from "./screens/ProgressScreen";
import { CompleteScreen } from "./screens/CompleteScreen";
import { VerifyScreen } from "./screens/VerifyScreen";

import { getReceipt } from "@/lib/api";
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

  const resetFlow = () => {
    entropySeed?.fill(0);
    setEntropySeed(null);
    contribution.reset();
    setStep("landing");
  };

  const handleCancelContribution = () => {
    contribution.cancel();
    entropySeed?.fill(0);
    setEntropySeed(null);
    setStep("landing");
  };

  const handleVerifyReceipt = async (input: string) => {
    const parsed = JSON.parse(input) as
      | {
          circuitId?: string;
          participantId?: string;
          contributionIndex?: number;
          contributionHash?: string;
        }
      | Array<{
          circuitId?: string;
          participantId?: string;
          contributionIndex?: number;
          contributionHash?: string;
        }>;

    const receiptList = Array.isArray(parsed) ? parsed : [parsed];
    if (receiptList.length === 0) {
      throw new Error(config.copy.verify.invalidReceipt);
    }

    for (const receipt of receiptList) {
      if (
        !receipt?.circuitId ||
        !receipt.participantId ||
        receipt.contributionIndex == null ||
        !receipt.contributionHash
      ) {
        throw new Error(config.copy.verify.invalidReceipt);
      }
    }

    const seen = new Set<string>();
    for (const receipt of receiptList) {
      const key = `${receipt.circuitId}#${receipt.contributionIndex}`;
      if (seen.has(key)) {
        throw new Error(config.copy.verify.duplicateReceipt);
      }
      seen.add(key);
    }

    return await Promise.all(
      receiptList.map(async (receipt) => {
        const stored = await getReceipt({
          circuitId: receipt.circuitId as string,
          participantId: receipt.participantId as string,
          contributionIndex: receipt.contributionIndex as number,
          contributionHash: receipt.contributionHash as string,
        });
        if (
          (receipt.contributionHash as string).toLowerCase() !==
          stored.contributionHash.toLowerCase()
        ) {
          throw new Error(
            formatTemplate(config.copy.verify.hashMismatch, {
              circuitId: receipt.circuitId as string,
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
                error={contribution.contributionError ?? contribution.queueError}
                autoRetrying={contribution.autoRetrying}
                autoRetryMessage={contribution.autoRetryMessage}
                autoRetryAttempt={contribution.autoRetryAttempt}
                autoRetryMax={contribution.autoRetryMax}
                finalizeEnabled={contribution.finalizeReady}
                onFinalize={() => setStep("complete")}
                onRetry={contribution.retry}
                onCancel={handleCancelContribution}
              />
            )}

            {step === "complete" && (
              <CompleteScreen
                receipts={contribution.receipts}
                onRestart={resetFlow}
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
