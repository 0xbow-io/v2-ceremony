import type { CeremonyCopy } from "./types/ceremony";

export const defaultCopy: CeremonyCopy = {
  header: {
    title: "TRUSTED SETUP CEREMONY",
    contributionsLabel: "contributions",
    steps: {
      landing: "Welcome",
      entropy: "Entropy",
      tier: "Select Tier",
      progress: "Progress",
      complete: "Complete",
      verify: "Verify",
    },
  },
  landing: {
    title: "Trusted Setup Ceremony",
    subtitle: "Contribute your randomness",
    description:
      "Your contribution strengthens the ceremony. Only one honest participant is needed.",
    stats: {
      contributionsLabel: "Contributors",
      circuitsLabel: "Circuits",
      progressLabel: "Progress",
    },
    authNote: "Sign in with GitHub to prevent spam and join the queue.",
    githubCta: "CONTINUE WITH GITHUB",
    beginCta: "BEGIN CONTRIBUTION",
    eligibilityLoadingCta: "CHECKING ELIGIBILITY...",
    downloadReceiptsCta: "DOWNLOAD MY RECEIPTS",
    downloadingReceiptsCta: "PREPARING DOWNLOAD...",
    alreadyContributedTitle: "You have already contributed",
    alreadyContributedDescription:
      "This GitHub account has contributed to every available circuit. You can still verify your receipts.",
    endedSubtitle: "This ceremony has concluded",
    endedDescription:
      "Thank you to everyone who contributed. The ceremony has reached its target. You can still verify existing receipts below.",
    verifyCta: "VERIFY A RECEIPT",
    footer:
      "GitHub sign-in required to prevent spam. No other data collected.\nTakes ~1 minute for core circuits.",
  },
  entropy: {
    topBarTitle: "ENTROPY COLLECTION",
    topBarHint: "Move around & tap for bursts",
    strengthLabel: "Entropy strength",
    readyCta: "CONTINUE",
    collectingCta: "COLLECTING ENTROPY...",
    helper:
      "Your movements are being mixed into cryptographic randomness that will help secure the ceremony.",
    overlayTitle: "Entropy collected",
    overlaySubtitle: "Your unique randomness is ready",
  },
  tier: {
    title: "Select contribution level",
    description:
      "Choose how many circuits to contribute to. More circuits = stronger ceremony.",
    cta: "JOIN QUEUE",
    joiningCta: "JOINING QUEUE...",
    tierLabelPrefix: "Tier",
    timeSuffix: "min",
    pillWillRun: "will run",
    pillAlreadyContributed: "already contributed",
    pillTargetReached: "target reached",
    pillNextAvailable: "next available",
  },
  progress: {
    title: "Contribution in progress",
    subtitle: "We will run each circuit in sequence. Keep this tab open.",
    listTitle: "Your circuits",
    activeTitle: "Active circuit",
    constraintsLabel: "constraints",
    queuePositionLabel: "Queue position",
    etaLabel: "ETA",
    statusLabels: {
      waiting: "Waiting",
      active: "Active",
      done: "Done",
      error: "Error",
    },
    phaseLabels: {
      downloading: "Download",
      computing: "Compute",
      uploading: "Upload",
      verifying: "Verify",
    },
    phaseStatus: {
      downloading: "Downloading zkey...",
      computing: "Computing contribution...",
      uploading: "Uploading result...",
      verifying: "Verifying contribution on the server...",
    },
    finalizeCta: "FINALIZE CONTRIBUTION",
    retryCta: "Retry",
    cancelCta: "Cancel",
    errorTitle: "Contribution failed",
    autoRetryLabel: "Retrying automatically… (attempt {{attempt}} of {{total}})",
    completeTitle: "All circuits complete",
    completeSubtitle: "Review your receipts and finalize.",
  },
  complete: {
    title: "Contribution Complete",
    subtitle: "Your randomness is now permanently woven into the ceremony.",
    contributionsTitle: "Your contributions",
    emptyContributions: "No receipts recorded yet.",
    downloadCta: "Download",
    verifyCta: "Verify",
    copyCta: "Copy Receipt",
    copiedCta: "Copied!",
    copyItemCta: "Copy hash",
    shareCta: "Share on X",
    receiptFilename: "ceremony-receipt.json",
    shareTemplate:
      "I just contributed to {{ceremonyName}}: {{circuitId}} #{{contributionIndex}}",
    toxicTitle: "Toxic waste destroyed",
    toxicBody:
      "Your secret randomness was generated in memory, used to transform the circuit keys, and immediately zeroed. No entropy was written to disk or transmitted to the coordinator.",
    toxicTags: [
      "WASM memory zeroed",
      "Entropy buffers cleared",
      "No disk writes",
    ],
    thankYouTitle: "Thank you for strengthening the ceremony.",
    thankYouBody:
      "Only one honest participant is needed. You might be that one.",
    restartCta: "CONTRIBUTE AGAIN (DIFFERENT TIER)",
    attestationTitle: "Publish an attestation (optional)",
    attestationBody:
      "Publish a public GitHub Gist — one click, using your GitHub login — leaving a timestamped record that your contribution happened. Voluntary; it proves inclusion, not honesty.",
    attestationPublishCta: "Publish as Gist",
    attestationPublishingCta: "Publishing…",
    attestationViewCta: "View Gist",
    attestationError: "Could not publish the Gist. Please try again.",
    attestationSignInError:
      "Sign in with GitHub again to grant Gist access, then retry.",
  },
  verify: {
    title: "Verify a receipt",
    subtitle:
      "Paste a receipt JSON to confirm it exists in the coordinator state.",
    label: "Receipt JSON",
    placeholder:
      '{"circuitId":"multiplier","participantId":"...","contributionIndex":1}',
    cta: "VERIFY RECEIPT",
    verifyingCta: "VERIFYING...",
    note: "This check confirms that the receipt's contribution hash matches the coordinator's record.",
    successTitle: "Receipt verified",
    invalidReceipt: "Receipt JSON is missing required fields.",
    duplicateReceipt:
      "Receipt list contains duplicate entries for the same contribution.",
    hashMismatch:
      "Submitted hash does not match the coordinator's record for {{circuitId}} #{{contributionIndex}}.",
    errorLabel: "Error",
    backCta: "BACK TO LANDING",
  },
};
