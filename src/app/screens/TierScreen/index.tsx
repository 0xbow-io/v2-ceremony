"use client";

import type { TierId } from "@/lib/ceremony-config";
import type { CircuitPreviewState, StatusResponse } from "@/lib/api";
import { useCeremonyConfig } from "@/hooks/useCeremonyConfig";
import { useCeremonyStatus } from "@/hooks/useCeremonyStatus";
import { useParticipantEligibility } from "@/hooks/useParticipantEligibility";
import { cn } from "@/utils/cn";
import { Button } from "@/app/components/Button";
import { ScreenWrapper } from "@/app/components/ScreenWrapper";
import styles from "./TierScreen.module.css";

function circuitProgress(
  circuitId: string,
  status: StatusResponse | null,
): { total: number; target: number } | null {
  if (!status) return null;
  const circuit = status.circuits.find((c) => c.circuitId === circuitId);
  if (!circuit) return null;
  return {
    total: circuit.totalContributions,
    target: circuit.targetContributions,
  };
}

const STATE_LABELS: Record<CircuitPreviewState, keyof PreviewCopy> = {
  willRun: "pillWillRun",
  fallback: "pillNextAvailable",
  alreadyContributed: "pillAlreadyContributed",
  targetReached: "pillTargetReached",
};

type PreviewCopy = {
  pillWillRun: string;
  pillAlreadyContributed: string;
  pillTargetReached: string;
  pillNextAvailable: string;
};

export function TierScreen({
  selectedTier,
  onSelectTier,
  onNext,
  isJoining = false,
}: {
  selectedTier: TierId;
  onSelectTier: (tier: TierId) => void;
  onNext: () => void;
  isJoining?: boolean;
}) {
  const config = useCeremonyConfig();
  const { status } = useCeremonyStatus();
  const { eligibility } = useParticipantEligibility();

  const { copy } = config;
  const tiers = config.tiers ?? [];

  return (
    <ScreenWrapper className="screenLayout">
      <div className={styles.header}>
        <h2 className="sectionTitle">{copy.tier.title}</h2>
        <p className="sectionSubtitle">{copy.tier.description}</p>
      </div>

      <div className={styles.tierList}>
        {tiers.map((tier, index) => {
          const selected = selectedTier === tier.id;
          const preview = eligibility?.tierPreviews.find(
            (entry) => entry.tierId === tier.id,
          );
          const items =
            preview?.items ??
            tier.circuitIds.map((circuitId) => ({
              circuitId,
              state: "willRun" as CircuitPreviewState,
            }));

          return (
            <button
              key={tier.id}
              onClick={() => onSelectTier(tier.id)}
              className={cn(
                styles.tierCard,
                selected && styles.tierCardSelected,
              )}
            >
              <div className={styles.tierTop}>
                <div className={styles.tierInfo}>
                  <div
                    className={cn(
                      styles.radio,
                      selected && styles.radioSelected,
                    )}
                  >
                    {selected && <div className={styles.radioDot} />}
                  </div>

                  <div>
                    <span className={styles.tierLabel}>
                      {copy.tier.tierLabelPrefix} {index + 1}:{" "}
                      {tier.id.toUpperCase()}
                    </span>
                    <span
                      className={cn(
                        styles.badge,
                        selected && styles.badgeSelected,
                        !selected && styles.badgeDefault,
                      )}
                    >
                      {tier.label}
                    </span>
                  </div>
                </div>
                <span className={styles.estimate}>
                  ~{tier.estimatedMinutes} {copy.tier.timeSuffix}
                </span>
              </div>

              <p className={styles.tierDescription}>{tier.description}</p>

              <div className={styles.chipList}>
                {items.map((item) => {
                  const progress = circuitProgress(item.circuitId, status);
                  const isSkipped =
                    item.state === "alreadyContributed" ||
                    item.state === "targetReached";
                  return (
                    <span
                      key={`${tier.id}:${item.circuitId}:${item.state}`}
                      className={cn(
                        styles.chip,
                        item.state === "willRun" && styles.chipWillRun,
                        item.state === "fallback" && styles.chipFallback,
                        isSkipped && styles.chipSkipped,
                      )}
                    >
                      {item.circuitId}
                      {progress && (
                        <span className={styles.chipProgress}>
                          {` ${progress.total}/${progress.target}`}
                        </span>
                      )}
                      {eligibility && (
                        <span className={styles.chipStatus}>
                          {copy.tier[STATE_LABELS[item.state]]}
                        </span>
                      )}
                    </span>
                  );
                })}
              </div>
            </button>
          );
        })}
      </div>

      <Button onClick={onNext} disabled={isJoining}>
        {isJoining ? copy.tier.joiningCta : copy.tier.cta}
      </Button>
    </ScreenWrapper>
  );
}
