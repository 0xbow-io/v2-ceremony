export type CeremonyStep =
  | "landing"
  | "entropy"
  | "tier"
  | "progress"
  | "complete"
  | "verify";

export type TierId = "core" | "popular" | "all";

export interface CircuitArtifactsConfig {
  r1csPath: string;
  ptauPath: string;
  wasmPath?: string;
}

export interface CeremonyCircuitConfig {
  id: string;
  label: string;
  description: string;
  constraints: string;
  targetContributions: number;
  // Optional override for how long a participant may hold this circuit's
  // front-of-queue slot before being rotated to the back (seconds). When unset
  // the cap is derived from `constraints` (see resolveMaxActiveSeconds).
  maxActiveSeconds?: number;
  artifacts: CircuitArtifactsConfig;
}

export interface CeremonyTierConfig {
  id: TierId;
  label: string;
  description: string;
  estimatedMinutes: number;
  circuitIds: string[];
}

export interface CeremonyCopy {
  header: {
    title: string;
    contributionsLabel: string;
    steps: {
      landing: string;
      entropy: string;
      tier: string;
      progress: string;
      complete: string;
      verify: string;
    };
  };
  landing: {
    title: string;
    subtitle: string;
    description: string;
    stats: {
      contributionsLabel: string;
      circuitsLabel: string;
      progressLabel: string;
    };
    authNote: string;
    githubCta: string;
    beginCta: string;
    eligibilityLoadingCta: string;
    downloadReceiptsCta: string;
    downloadingReceiptsCta: string;
    timeNoticeTitle: string;
    timeNoticeBody: string;
    alreadyContributedTitle: string;
    alreadyContributedDescription: string;
    // Shown when contributions have stopped but the ceremony is NOT yet
    // finalized (beacon not applied) — makes clear that work remains.
    closedSubtitle: string;
    closedDescription: string;
    // Shown only once the ceremony is fully finalized (beacon applied).
    endedSubtitle: string;
    endedDescription: string;
    verifyCta: string;
    forAgentsCta: string;
    footer: string;
  };
  entropy: {
    topBarTitle: string;
    topBarHint: string;
    strengthLabel: string;
    readyCta: string;
    collectingCta: string;
    helper: string;
    overlayTitle: string;
    overlaySubtitle: string;
  };
  tier: {
    title: string;
    description: string;
    cta: string;
    joiningCta: string;
    tierLabelPrefix: string;
    timeSuffix: string;
    pillWillRun: string;
    pillAlreadyContributed: string;
    pillTargetReached: string;
    pillNextAvailable: string;
  };
  progress: {
    title: string;
    subtitle: string;
    listTitle: string;
    activeTitle: string;
    constraintsLabel: string;
    queueAhead: string;
    queueNext: string;
    etaLabel: string;
    etaEstimating: string;
    etaRemaining: string;
    statusLabels: {
      waiting: string;
      active: string;
      done: string;
      error: string;
    };
    phaseLabels: {
      downloading: string;
      computing: string;
      uploading: string;
      verifying: string;
    };
    phaseStatus: {
      downloading: string;
      computing: string;
      uploading: string;
      verifying: string;
    };
    retryCta: string;
    cancelCta: string;
    errorTitle: string;
    autoRetryLabel: string;
    completeTitle: string;
    completeSubtitle: string;
  };
  complete: {
    title: string;
    subtitle: string;
    contributionsTitle: string;
    emptyContributions: string;
    downloadCta: string;
    verifyCta: string;
    copyCta: string;
    copiedCta: string;
    copyItemCta: string;
    shareCta: string;
    receiptFilename: string;
    shareTemplate: string;
    toxicTitle: string;
    toxicBody: string;
    toxicTags: string[];
    thankYouTitle: string;
    thankYouBody: string;
    attestationTitle: string;
    attestationBody: string;
    attestationPublishCta: string;
    attestationPublishingCta: string;
    attestationViewCta: string;
    attestationError: string;
    attestationSignInError: string;
  };
  verify: {
    title: string;
    subtitle: string;
    label: string;
    placeholder: string;
    cta: string;
    verifyingCta: string;
    note: string;
    successTitle: string;
    invalidReceipt: string;
    duplicateReceipt: string;
    hashMismatch: string;
    errorLabel: string;
    backCta: string;
  };
}

export interface CeremonyConfig {
  name: string;
  slug: string;
  description: string;
  targetContributions: number;
  endDate: string | null;
  queueTimeoutSeconds: number;
  // Grace period (seconds) for the participant who just reached the FRONT to
  // prove they are alive (a fast claim ping from their client). If nothing
  // arrives within this window they are treated as a no-show — a closed/dead
  // tab — and skipped, instead of holding the slot for the full active-slot cap.
  claimWindowSeconds: number;
  // How many no-shows on a circuit before the participant is temporarily blocked
  // from re-joining that circuit's queue (so a tab that will never respond stops
  // being counted as a queue member).
  maxNoShows: number;
  // How long that block lasts before it auto-lifts, so a real contributor who hit
  // a transient issue can return without operator help.
  noShowCooldownSeconds: number;
  verifyContributions?: boolean;
  tiersEnabled?: boolean;
  tiers?: CeremonyTierConfig[];
  circuits: CeremonyCircuitConfig[];
  branding: {
    shortName: string;
    accentColor: string;
  };
  storage: {
    manifestPath: string;
    circuitStatePrefix: string;
    receiptsPath: string;
    participantContributionsPrefix: string;
    participantsIndexPath: string;
    zkeyPrefix: string;
    // Prefix for the per-participant per-circuit no-show counter keys.
    noShowPrefix: string;
    // Prefix for the per-participant opaque run-token keys (see QueueEntry.publicToken).
    runTokenPrefix: string;
  };
  copy: CeremonyCopy;
}

export type ClientCircuitConfig = Omit<CeremonyCircuitConfig, "artifacts">;

export type ClientCeremonyConfig = Omit<CeremonyConfig, "circuits"> & {
  circuits: ClientCircuitConfig[];
};
