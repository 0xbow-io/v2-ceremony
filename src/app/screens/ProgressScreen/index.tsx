"use client";

import { useCeremonyConfig } from "@/hooks/useCeremonyConfig";
import { cn } from "@/utils/cn";
import { formatTemplate } from "@/utils/format";
import { ScreenWrapper } from "@/app/components/ScreenWrapper";
import styles from "./ProgressScreen.module.css";

export type ContribPhase =
  | "downloading"
  | "computing"
  | "uploading"
  | "verifying";

// Canonical phase order. The progress bar marks a step done when its index is
// before the current phase, so any new phase only needs adding here in order.
const PHASE_ORDER: ContribPhase[] = [
  "downloading",
  "computing",
  "uploading",
  "verifying",
];

export type CircuitRunStatus = "waiting" | "active" | "done" | "error";

export interface CircuitRunItem {
  id: string;
  label: string;
  status: CircuitRunStatus;
  position?: number;
  etaSeconds?: number;
}

export interface ActiveCircuitInfo {
  id: string;
  label: string;
  constraints: string;
  index: number;
  count: number;
}

export function ProgressScreen({
  circuits,
  activeCircuit,
  phase,
  progress,
  etaSecondsRemaining,
  error,
  autoRetrying,
  autoRetryMessage,
  autoRetryAttempt,
  autoRetryMax,
  onRetry,
  onCancel,
}: {
  circuits: CircuitRunItem[];
  activeCircuit: ActiveCircuitInfo | null;
  phase: ContribPhase;
  progress: number;
  etaSecondsRemaining: number | null;
  error: string | null;
  autoRetrying: boolean;
  autoRetryMessage: string | null;
  autoRetryAttempt: number;
  autoRetryMax: number;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const { copy } = useCeremonyConfig();
  const barProgress = Math.min(progress, 100);
  const phaseStatus = copy.progress.phaseStatus[phase];

  // The current circuit is either waiting in the queue or actively computing.
  // Compute phases (phase bar, progress, ETA) belong to the computing state;
  // the queue banner belongs to the waiting state.
  const currentRun = activeCircuit
    ? circuits.find((circuit) => circuit.id === activeCircuit.id)
    : undefined;
  const isComputing = Boolean(activeCircuit) && currentRun?.status === "active";
  const isWaitingInLine =
    Boolean(activeCircuit) && currentRun?.status === "waiting";

  // "You're next" at the front of the line, otherwise "N ahead of you".
  const queueText = (position: number): string =>
    position <= 1
      ? copy.progress.queueNext
      : formatTemplate(copy.progress.queueAhead, {
          count: String(position - 1),
        });

  return (
    <ScreenWrapper className="screenLayout">
      <div className={styles.header}>
        <h2 className="sectionTitle">{copy.progress.title}</h2>
        <p className="sectionSubtitle">{copy.progress.subtitle}</p>
      </div>

      {activeCircuit && (
        <div className={styles.activeInfo}>
          <div className="label">{copy.progress.activeTitle}</div>
          <div className={styles.activeCircuit}>
            {activeCircuit.label}{" "}
            <span className={styles.activeCount}>
              ({activeCircuit.index + 1}/{activeCircuit.count})
            </span>
          </div>
          <div className={styles.activeConstraints}>
            {activeCircuit.constraints} {copy.progress.constraintsLabel}
          </div>
        </div>
      )}

      {!activeCircuit && (
        <div className={styles.activeInfo}>
          <div className={styles.completedTitle}>
            {copy.progress.completeTitle}
          </div>
          <div className={styles.completedSubtitle}>
            {copy.progress.completeSubtitle}
          </div>
        </div>
      )}

      {isWaitingInLine && currentRun?.position != null && (
        <div className={styles.queueBanner}>
          <div className={styles.queueSpinner} />
          <span className={styles.queueBannerText}>
            {queueText(currentRun.position)}
          </span>
        </div>
      )}

      {isComputing && <div className={styles.processingIndicator} />}

      {isComputing && (
        <div className={styles.phaseBar}>
          {PHASE_ORDER.map(
            (p, i) => {
              const isActive = phase === p;
              const isDone = PHASE_ORDER.indexOf(phase) > i;

              return (
                <div key={p} className={styles.phaseGroup}>
                  {i > 0 && (
                    <div
                      className={cn(
                        styles.phaseLine,
                        (isActive || isDone) && styles.phaseLineActive,
                        !isActive && !isDone && styles.phaseLineInactive,
                      )}
                    />
                  )}

                  <div className={styles.phaseStep}>
                    <div
                      className={cn(
                        styles.phaseDot,
                        isActive && styles.phaseDotActive,
                        !isActive && isDone && styles.phaseDotDone,
                        !isActive && !isDone && styles.phaseDotPending,
                      )}
                    />
                    <span
                      className={cn(
                        styles.phaseLabel,
                        isActive && styles.phaseLabelActive,
                        !isActive && styles.phaseLabelInactive,
                      )}
                    >
                      {copy.progress.phaseLabels[p]}
                    </span>
                  </div>
                </div>
              );
            },
          )}
        </div>
      )}

      {isComputing && (
        <div className={styles.progressSection}>
          <div className={styles.progressTrack}>
            <div
              className={styles.progressFill}
              style={{ width: `${barProgress}%` }}
            />
          </div>
          <div className={styles.progressMeta}>
            <span>{phaseStatus}</span>
            <span>{Math.min(Math.floor(barProgress), 100)}%</span>
          </div>
          <div className={styles.eta}>
            {etaSecondsRemaining === null
              ? copy.progress.etaEstimating
              : formatTemplate(copy.progress.etaRemaining, {
                  time: formatDuration(etaSecondsRemaining),
                })}
          </div>
        </div>
      )}

      <div className={styles.circuitList}>
        <div className={cn("label", styles.circuitListLabel)}>
          {copy.progress.listTitle}
        </div>

        {circuits.map((circuit) => (
          <div key={circuit.id} className={styles.circuitItem}>
            <div className={styles.circuitItemLeft}>
              <StatusIcon status={circuit.status} />
              <span className={styles.circuitLabel}>{circuit.label}</span>
            </div>

            <div className={styles.circuitItemRight}>
              <span className={styles.circuitStatus}>
                {copy.progress.statusLabels[circuit.status]}
              </span>

              {circuit.status === "waiting" && circuit.position != null && (
                <span>{queueText(circuit.position)}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {(autoRetrying || error) && (
        <div className="card">
          <div className={styles.errorBlock}>
            <div className={styles.errorTitle}>{copy.progress.errorTitle}</div>
            <div>{autoRetrying ? autoRetryMessage : error}</div>

            {autoRetrying ? (
              <div className={styles.retryStatus}>
                <div className={styles.retrySpinner} />
                <span>
                  {formatTemplate(copy.progress.autoRetryLabel, {
                    attempt: String(autoRetryAttempt),
                    total: String(autoRetryMax),
                  })}
                </span>
              </div>
            ) : (
              <div className={styles.errorActions}>
                <button onClick={onRetry} className={styles.errorButton}>
                  {copy.progress.retryCta}
                </button>
                <button onClick={onCancel} className={styles.errorButton}>
                  {copy.progress.cancelCta}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </ScreenWrapper>
  );
}

// Human-friendly duration for the live ETA: "<1 min", "12 min", "1 hr 5 min".
function formatDuration(totalSeconds: number): string {
  const seconds = Math.round(totalSeconds);
  if (seconds < 60) return "<1 min";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours} hr ${remMinutes} min` : `${hours} hr`;
}

function StatusIcon({ status }: { status: CircuitRunStatus }) {
  if (status === "done") {
    return (
      <div className={styles.iconDone}>
        <svg
          className={styles.iconDoneSvg}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className={styles.iconError}>
        <span className={styles.iconErrorText}>!</span>
      </div>
    );
  }

  if (status === "active") {
    return <div className={styles.iconActive} />;
  }

  return (
    <div className={styles.iconWaiting}>
      <div className={styles.iconSpinner} />
    </div>
  );
}
