"use client";

import { useRef, useState, useCallback } from "react";

import { useCeremonyConfig } from "@/hooks/useCeremonyConfig";
import { useCeremonyStatus } from "@/hooks/useCeremonyStatus";
import { useParticipant } from "@/hooks/useParticipant";
import { useEntropyCollector } from "@/hooks/useEntropyCollector";
import { cn } from "@/utils/cn";
import styles from "./EntropyScreen.module.css";

export function EntropyScreen({
  onComplete,
}: {
  onComplete: (entropy: Uint8Array) => void;
}) {
  const config = useCeremonyConfig();
  const { status } = useCeremonyStatus();
  const { isAuthenticated, participantName } = useParticipant();

  const { copy } = config;
  const shortName = config.branding.shortName;
  const totalContributions = status?.totalContributions;
  const displayName = isAuthenticated ? participantName : undefined;
  const {
    entropyPercent,
    isReady,
    areaRef,
    handlePointerMove,
    recordTap,
    recordKeyPress,
    buildSeed,
  } = useEntropyCollector();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([]);
  const rippleIdRef = useRef(0);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = areaRef.current;
      if (!el) return;
      el.setPointerCapture(e.pointerId);
    },
    [areaRef],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (isReady) return;

      const el = areaRef.current;
      if (!el) return;

      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const id = rippleIdRef.current++;
      setRipples((prev) => [...prev, { id, x, y }]);
      setTimeout(() => {
        setRipples((prev) => prev.filter((r) => r.id !== id));
      }, 600);

      recordTap(x, y);
    },
    [isReady, areaRef, recordTap],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (isReady || e.repeat) return;
      recordKeyPress(e.keyCode);
    },
    [isReady, recordKeyPress],
  );

  const handleSubmit = useCallback(async () => {
    if (!isReady || isSubmitting) return;
    setIsSubmitting(true);
    const seed = await buildSeed();
    onComplete(seed);
  }, [isReady, isSubmitting, buildSeed, onComplete]);

  const barWidth = Math.min(entropyPercent, 100);

  return (
    <div className={styles.container}>
      <div
        ref={areaRef}
        role="application"
        tabIndex={0}
        aria-label={copy.entropy.topBarTitle}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onKeyDown={handleKeyDown}
        className={styles.interactiveArea}
      >
        {ripples.map((r) => (
          <div
            key={r.id}
            className={styles.clickRipple}
            style={{
              left: r.x,
              top: r.y,
              transform: "translate(-50%, -50%)",
            }}
          />
        ))}
      </div>

      <div className={styles.topBarWrapper}>
        <div className={styles.topBar}>
          <div className={styles.topBarLeft}>
            <div className={styles.logoIcon}>
              <span className={styles.logoText}>{shortName}</span>
            </div>
            <div className={styles.logoDivider} />
            <span className={styles.topBarTitle}>{copy.entropy.topBarTitle}</span>
          </div>
          <div className={styles.topBarRight}>
            <span className={styles.topBarHint}>{copy.entropy.topBarHint}</span>

            {displayName && (
              <>
                <div className={styles.divider} />
                <span className={styles.topBarUser}>@{displayName}</span>
              </>
            )}

            <div className={styles.divider} />
            <div className={styles.topBarContributions}>
              <div className="accentDot" />
              <span className={styles.topBarContributionsLabel}>
                {(totalContributions ?? 0).toLocaleString()}{" "}
                {copy.header.contributionsLabel}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.bottomPanel}>
        <div className={styles.bottomContent}>
          <div className={styles.progressCard}>
            <div className={styles.progressInner}>
              <div className={styles.progressHeader}>
                <span className={styles.progressLabel}>
                  {copy.entropy.strengthLabel}
                </span>
                <span
                  className={cn(
                    styles.progressValue,
                    isReady && styles.progressValueReady,
                  )}
                >
                  {entropyPercent}%
                </span>
              </div>

              <div className={styles.progressTrack}>
                <div
                  className={styles.progressFill}
                  style={{
                    width: `${barWidth}%`,
                    background: isReady
                      ? "var(--color-accent)"
                      : "linear-gradient(90deg, #CCCCCC, var(--color-accent))",
                  }}
                />
              </div>

              <p className={styles.progressHelper}>{copy.entropy.helper}</p>
            </div>
          </div>

          <button
            onClick={handleSubmit}
            disabled={!isReady || isSubmitting}
            className={cn(
              styles.continueButton,
              isReady && !isSubmitting && styles.continueReady,
              (!isReady || isSubmitting) && styles.continueDisabled,
            )}
          >
            {isReady && copy.entropy.readyCta}
            {!isReady && copy.entropy.collectingCta}
          </button>
        </div>
      </div>

      {isReady && (
        <div className={styles.overlay}>
          <div className={styles.overlayContent}>
            <div className={styles.overlayIcon}>
              <svg
                className={styles.overlayIconSvg}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>

            <div className={styles.overlayTitle}>
              {copy.entropy.overlayTitle}
            </div>

            <div className={styles.overlaySubtitle}>
              {copy.entropy.overlaySubtitle}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
