"use client";

import type { CeremonyStep } from "@/lib/ceremony-config";
import { useCeremonyConfig } from "@/hooks/useCeremonyConfig";
import { useCeremonyStatus } from "@/hooks/useCeremonyStatus";
import { useParticipant } from "@/hooks/useParticipant";
import styles from "./Header.module.css";

export function Header({
  onLogoClick,
}: {
  step: CeremonyStep;
  onLogoClick?: () => void;
}) {
  const config = useCeremonyConfig();
  const { status } = useCeremonyStatus();
  const { isAuthenticated, participantName } = useParticipant();

  const { copy } = config;
  const shortName = config.branding.shortName;
  const totalContributions = status?.totalContributions;
  const displayName = isAuthenticated ? participantName : undefined;

  return (
    <header className={styles.header}>
      <button onClick={onLogoClick} className={styles.logoButton}>
        <div className={styles.logoIcon}>
          <span className={styles.logoText}>
            {shortName ?? "TS"}
          </span>
        </div>
        <div className={styles.logoDivider} />
        <span className={styles.title}>{copy.header.title}</span>
      </button>

      <div className={styles.nav}>
        {displayName && (
          <>
            <span className={styles.userBadge}>@{displayName}</span>
            <div className={styles.divider} />
          </>
        )}
        <div className={styles.contributions}>
          <div className="accentDot" />
          <span className={styles.contributionsLabel}>
            {(totalContributions ?? 0).toLocaleString()} {copy.header.contributionsLabel}
          </span>
        </div>
      </div>
    </header>
  );
}
