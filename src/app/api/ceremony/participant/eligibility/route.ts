import { NextRequest, NextResponse } from "next/server";

import {
  getAllCircuitStates,
  getParticipantContributedCircuitIds,
  selectCircuitsForTier,
  type CircuitState,
} from "@/lib/ceremony-state";
import {
  getCeremonyConfig,
  type CeremonyTierConfig,
} from "@/lib/ceremony-config";
import { getParticipant } from "@/lib/participant-auth";

type CircuitPreviewState =
  | "willRun"
  | "alreadyContributed"
  | "targetReached"
  | "fallback";

type TierPreview = {
  tierId: string;
  items: Array<{ circuitId: string; state: CircuitPreviewState }>;
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  const participant = await getParticipant(request);
  if (!participant) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const config = getCeremonyConfig();
  const [circuits, contributedCircuitIds] = await Promise.all([
    getAllCircuitStates(),
    getParticipantContributedCircuitIds(participant.participantId),
  ]);

  const eligibleCircuitIds = config.circuits
    .filter((circuitConfig) => {
      if (contributedCircuitIds.has(circuitConfig.id)) {
        return false;
      }
      const circuit = circuits.find((state) => state.id === circuitConfig.id);
      return (
        !circuit ||
        circuit.totalContributions < circuitConfig.targetContributions
      );
    })
    .map((circuit) => circuit.id);

  const tiers = config.tiers ?? [];
  const tierPreviews = tiers.map((tier) =>
    buildTierPreview(tier, {
      tiers,
      config,
      circuits,
      contributedCircuitIds,
      eligibleCircuitIds,
    }),
  );

  return NextResponse.json({
    participantId: participant.participantId,
    contributedCircuitIds: Array.from(contributedCircuitIds),
    eligibleCircuitIds,
    hasEligibleCircuits: eligibleCircuitIds.length > 0,
    tierPreviews,
  });
}

function buildTierPreview(
  tier: CeremonyTierConfig,
  context: {
    tiers: CeremonyTierConfig[];
    config: ReturnType<typeof getCeremonyConfig>;
    circuits: CircuitState[];
    contributedCircuitIds: Set<string>;
    eligibleCircuitIds: string[];
  },
): TierPreview {
  const { tiers, config, circuits, contributedCircuitIds, eligibleCircuitIds } =
    context;

  const resolvedIds = selectCircuitsForTier(
    tier.id,
    tiers,
    config.circuits,
    circuits,
  );
  const executable = resolvedIds.filter(
    (id) => !contributedCircuitIds.has(id),
  );
  const fallbackId = executable[0] ?? eligibleCircuitIds[0] ?? null;
  const willRunIds = new Set(
    executable.length > 0 ? executable : fallbackId ? [fallbackId] : [],
  );
  const tierIds = new Set(tier.circuitIds);

  const items: Array<{ circuitId: string; state: CircuitPreviewState }> =
    tier.circuitIds.map((circuitId) => {
      if (willRunIds.has(circuitId)) {
        return { circuitId, state: "willRun" as const };
      }
      if (contributedCircuitIds.has(circuitId)) {
        return { circuitId, state: "alreadyContributed" as const };
      }
      return { circuitId, state: "targetReached" as const };
    });

  for (const circuitId of willRunIds) {
    if (!tierIds.has(circuitId)) {
      items.push({ circuitId, state: "fallback" });
    }
  }

  return { tierId: tier.id, items };
}
