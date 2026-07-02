import { defaultCopy } from "./src/copy";

export type {
  CeremonyCircuitConfig,
  CeremonyConfig,
  CeremonyCopy,
  CeremonyTierConfig,
  CircuitArtifactsConfig,
  ClientCeremonyConfig,
  ClientCircuitConfig,
  TierId,
} from "./src/types/ceremony";

import type {
  CeremonyConfig,
  ClientCeremonyConfig,
} from "./src/types/ceremony";

export function getCeremonyConfig(): CeremonyConfig {
  return ceremonyConfig;
}

export function getClientConfig(): ClientCeremonyConfig {
  const { circuits, ...rest } = ceremonyConfig;
  return {
    ...rest,
    circuits: circuits.map(({ artifacts, ...circuit }) => circuit),
  };
}

const CIRCUITS_DIR = "circuits";
const PTAU_PATH = `${CIRCUITS_DIR}/pot_final.ptau`;

export const ceremonyConfig: CeremonyConfig = {
  name: "ppv2-tsc-test",
  slug: "ppv2-tsc-test",
  description:
    "Contribute your randomness to strengthen the ceremony and improve system security.",
  targetContributions: 5,
  endDate: "2026-07-01",
  queueTimeoutSeconds: 300,
  verifyContributions: false,
  tiersEnabled: false,
  tiers: [

  ],
  circuits: [
    {
      id: "deposit",
      label: "Deposit",
      description: "Deposit funds into the privacy pool.",
      constraints: "2,061",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/deposit.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "ragequit",
      label: "Ragequit",
      description: "Exit the privacy pool and withdraw your full deposit.",
      constraints: "13,440",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/ragequit.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_1x1",
      label: "Transact 1×1",
      description: "Private transfer with 1 input note and 1 output note.",
      constraints: "37,672",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_1x1.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_1x2",
      label: "Transact 1×2",
      description: "Private transfer with 1 input note and 2 output notes.",
      constraints: "39,334",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_1x2.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_1x3",
      label: "Transact 1×3",
      description: "Private transfer with 1 input note and 3 output notes.",
      constraints: "41,004",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_1x3.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_1x4",
      label: "Transact 1×4",
      description: "Private transfer with 1 input note and 4 output notes.",
      constraints: "42,682",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_1x4.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_1x5",
      label: "Transact 1×5",
      description: "Private transfer with 1 input note and 5 output notes.",
      constraints: "44,368",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_1x5.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_2x1",
      label: "Transact 2×1",
      description: "Private transfer with 2 input notes and 1 output note.",
      constraints: "62,249",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_2x1.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_2x2",
      label: "Transact 2×2",
      description: "Private transfer with 2 input notes and 2 output notes.",
      constraints: "63,916",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_2x2.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_2x3",
      label: "Transact 2×3",
      description: "Private transfer with 2 input notes and 3 output notes.",
      constraints: "65,591",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_2x3.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_2x4",
      label: "Transact 2×4",
      description: "Private transfer with 2 input notes and 4 output notes.",
      constraints: "67,274",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_2x4.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_2x5",
      label: "Transact 2×5",
      description: "Private transfer with 2 input notes and 5 output notes.",
      constraints: "68,965",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_2x5.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_3x1",
      label: "Transact 3×1",
      description: "Private transfer with 3 input notes and 1 output note.",
      constraints: "86,825",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_3x1.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_3x2",
      label: "Transact 3×2",
      description: "Private transfer with 3 input notes and 2 output notes.",
      constraints: "88,496",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_3x2.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_3x3",
      label: "Transact 3×3",
      description: "Private transfer with 3 input notes and 3 output notes.",
      constraints: "90,175",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_3x3.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_3x4",
      label: "Transact 3×4",
      description: "Private transfer with 3 input notes and 4 output notes.",
      constraints: "91,862",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_3x4.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_3x5",
      label: "Transact 3×5",
      description: "Private transfer with 3 input notes and 5 output notes.",
      constraints: "93,557",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_3x5.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_4x1",
      label: "Transact 4×1",
      description: "Private transfer with 4 input notes and 1 output note.",
      constraints: "111,401",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_4x1.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_4x2",
      label: "Transact 4×2",
      description: "Private transfer with 4 input notes and 2 output notes.",
      constraints: "113,076",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_4x2.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_4x3",
      label: "Transact 4×3",
      description: "Private transfer with 4 input notes and 3 output notes.",
      constraints: "114,759",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_4x3.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_4x4",
      label: "Transact 4×4",
      description: "Private transfer with 4 input notes and 4 output notes.",
      constraints: "116,450",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_4x4.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_4x5",
      label: "Transact 4×5",
      description: "Private transfer with 4 input notes and 5 output notes.",
      constraints: "118,149",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_4x5.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_5x1",
      label: "Transact 5×1",
      description: "Private transfer with 5 input notes and 1 output note.",
      constraints: "135,977",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_5x1.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_5x2",
      label: "Transact 5×2",
      description: "Private transfer with 5 input notes and 2 output notes.",
      constraints: "137,656",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_5x2.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_5x3",
      label: "Transact 5×3",
      description: "Private transfer with 5 input notes and 3 output notes.",
      constraints: "139,343",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_5x3.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_5x4",
      label: "Transact 5×4",
      description: "Private transfer with 5 input notes and 4 output notes.",
      constraints: "141,038",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_5x4.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
    {
      id: "transact_5x5",
      label: "Transact 5×5",
      description: "Private transfer with 5 input notes and 5 output notes.",
      constraints: "142,741",
      targetContributions: 5,
      artifacts: {
        r1csPath: `${CIRCUITS_DIR}/transact_5x5.r1cs`,
        ptauPath: PTAU_PATH,
      },
    },
  ],
  branding: {
    shortName: "PP",
    accentColor: "#95C23A",
  },
  storage: {
    manifestPath: "ceremony:manifest",
    circuitStatePrefix: "ceremony:circuits",
    receiptsPath: "ceremony:receipts",
    participantContributionsPrefix: "ceremony:contributions:participants",
    participantsIndexPath: "ceremony:contributions:participants:index",
    zkeyPrefix: "ppv2-tsc-test/zkeys",
  },
  copy: defaultCopy,
};
