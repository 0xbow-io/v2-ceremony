"use client";

import { useState } from "react";

import { useCeremonyConfig } from "@/hooks/useCeremonyConfig";
import { useCeremonyStatus } from "@/hooks/useCeremonyStatus";
import { useParticipant } from "@/hooks/useParticipant";
import { useParticipantEligibility } from "@/hooks/useParticipantEligibility";
import { getMyReceipts } from "@/lib/api";
import { cn } from "@/utils/cn";
import { Button } from "@/app/components/Button";
import { ScreenWrapper } from "@/app/components/ScreenWrapper";
import styles from "./LandingScreen.module.css";

export function LandingScreen({
  onAuth,
  onBegin,
  onVerify,
}: {
  onAuth: (method: "github") => void;
  onBegin: () => void;
  onVerify: () => void;
}) {
  const config = useCeremonyConfig();
  const { status } = useCeremonyStatus();
  const { isAuthenticated } = useParticipant();
  const { eligibility, eligibilityLoading } = useParticipantEligibility();
  const [downloadingReceipts, setDownloadingReceipts] = useState(false);

  const { copy } = config;
  const totalContributions = status?.totalContributions ?? 0;
  const targetContributions =
    status?.targetContributions ?? config.targetContributions;
  const progress = targetContributions
    ? Math.min(
        100,
        Math.round((totalContributions / targetContributions) * 100),
      )
    : 0;
  const isActive = status?.isActive ?? true;
  const footerLines = copy.landing.footer.split("\n");
  const hasEligibleCircuits = eligibility?.hasEligibleCircuits ?? true;
  const hasReceipts = (eligibility?.contributedCircuitIds.length ?? 0) > 0;
  const beginCta = eligibilityLoading
    ? copy.landing.eligibilityLoadingCta
    : copy.landing.beginCta;

  const handleDownloadReceipts = async () => {
    if (downloadingReceipts) return;
    setDownloadingReceipts(true);
    try {
      const data = await getMyReceipts();
      const payload = JSON.stringify(data.receipts, null, 2);
      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = copy.complete.receiptFilename;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      /* surfaced via re-enabling the button; no inline error UI on landing */
    } finally {
      setDownloadingReceipts(false);
    }
  };

  const statsData = [
    {
      label: copy.landing.stats.contributionsLabel,
      value: totalContributions.toLocaleString(),
    },
    {
      label: copy.landing.stats.circuitsLabel,
      value: String(config.circuits.length),
    },
    { label: copy.landing.stats.progressLabel, value: `${progress}%` },
  ];

  if (!isActive) {
    return (
      <ScreenWrapper className="screenLayout">
        <div className={styles.hero}>
          <h1 className={styles.title}>{copy.landing.title}</h1>
          <h2 className={styles.subtitleEnded}>{copy.landing.endedSubtitle}</h2>
        </div>

        <StatsBar stats={statsData} />

        <div className={cn("card", styles.endedCard)}>
          <p className={styles.endedText}>{copy.landing.endedDescription}</p>
        </div>

        <Button onClick={onVerify}>{copy.landing.verifyCta}</Button>
      </ScreenWrapper>
    );
  }

  return (
    <ScreenWrapper className="screenLayout">
      <div className={styles.hero}>
        <h1 className={styles.title}>{copy.landing.title}</h1>
        <h2 className={styles.subtitle}>{copy.landing.subtitle}</h2>
        <p className={styles.description}>{copy.landing.description}</p>
      </div>

      <StatsBar stats={statsData} />

      {!isAuthenticated && (
        <>
          <div className="card">{copy.landing.authNote}</div>

          <div className={styles.authButtons}>
            <Button onClick={() => onAuth("github")}>
              {copy.landing.githubCta}
            </Button>
          </div>
        </>
      )}

      {isAuthenticated && (
        <>
          {!hasEligibleCircuits && (
            <div className={cn("card", styles.alreadyContributedCard)}>
              <h3 className={styles.alreadyContributedTitle}>
                {copy.landing.alreadyContributedTitle}
              </h3>
              <p className={styles.alreadyContributedText}>
                {copy.landing.alreadyContributedDescription}
              </p>
            </div>
          )}

          {hasEligibleCircuits && (
            <Button onClick={onBegin} disabled={eligibilityLoading}>
              {beginCta}
            </Button>
          )}
        </>
      )}

      {isAuthenticated && hasReceipts && (
        <Button
          variant="secondary"
          size="small"
          onClick={handleDownloadReceipts}
          disabled={downloadingReceipts}
        >
          {downloadingReceipts
            ? copy.landing.downloadingReceiptsCta
            : copy.landing.downloadReceiptsCta}
        </Button>
      )}

      <Button variant="secondary" size="small" onClick={onVerify}>
        {copy.landing.verifyCta}
      </Button>

      <p className={styles.footer}>
        {footerLines.map((line, index) => (
          <span key={line}>
            {line}
            {index < footerLines.length - 1 && <br />}
          </span>
        ))}
      </p>
    </ScreenWrapper>
  );
}

function StatsBar({
  stats,
}: {
  stats: Array<{ label: string; value: string }>;
}) {
  return (
    <div className={styles.statsBar}>
      {stats.map((stat, index) => (
        <div
          key={stat.label}
          className={cn(styles.statCell, index > 0 && styles.statCellBorder)}
        >
          <div className={styles.statValue}>{stat.value}</div>
          <div className={styles.statLabel}>{stat.label}</div>
        </div>
      ))}
    </div>
  );
}
