import { NextResponse } from "next/server";
import {
  getAllCircuitStates,
  getManifest,
  isCeremonyActive,
} from "@/lib/ceremony-state";
import { getCeremonyConfig } from "@/lib/ceremony-config";

export async function GET() {
  const config = getCeremonyConfig();
  const manifest = await getManifest();
  const circuits = await getAllCircuitStates();
  const isActive = isCeremonyActive(manifest, circuits);

  const circuitStatuses = circuits.map((circuit) => {
    const circuitConfig = config.circuits.find((c) => c.id === circuit.id);
    const target = circuitConfig?.targetContributions ?? 0;
    return {
      circuitId: circuit.id,
      targetContributions: target,
      totalContributions: circuit.totalContributions,
      currentParticipant: circuit.queue[0]?.participantId ?? null,
      queueLength: circuit.queue.length,
      latestContributionHash: circuit.latestContributionHash,
      chainHash: circuit.chainHash,
      isComplete: circuit.totalContributions >= target,
    };
  });

  const totalTarget = config.circuits.reduce(
    (sum, c) => sum + c.targetContributions,
    0,
  );

  return NextResponse.json({
    isActive,
    totalContributions: circuits.reduce(
      (sum, circuit) => sum + circuit.totalContributions,
      0,
    ),
    targetContributions: totalTarget,
    endDate: manifest.endDate,
    startedAt: manifest.startedAt,
    beaconApplied: manifest.beaconApplied ?? false,
    beaconHash: manifest.beaconHash ?? null,
    finalizedAt: manifest.finalizedAt ?? null,
    circuits: circuitStatuses,
  });
}
