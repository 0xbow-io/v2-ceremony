import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

import { getCeremonyConfig } from "@/lib/ceremony-config";
import {
  getAllCircuitStates,
  getCircuitState,
  getManifest,
  hasParticipantContributedToCircuit,
  isCeremonyActive,
  pruneExpiredEntries,
  reconcileFront,
  resolveMaxActiveSeconds,
} from "@/lib/ceremony-state";
import { getParticipant } from "@/lib/participant-auth";

// Machine-readable reason a circuit refused work because it already hit its
// target. The client treats it as a seamless skip, never an error/retry. Kept in
// sync with the contribute route and the client (see useContributionFlow).
const CIRCUIT_TARGET_REACHED = "CIRCUIT_TARGET_REACHED";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => {
        const participant = await getParticipant(request);
        if (!participant) {
          throw new Error("Unauthorized");
        }

        const config = getCeremonyConfig();
        const manifest = await getManifest();
        const allCircuits = await getAllCircuitStates();

        if (!isCeremonyActive(manifest, allCircuits)) {
          throw new Error("Ceremony is not active");
        }

        if (
          await hasParticipantContributedToCircuit(
            participant.participantId,
            id,
          )
        ) {
          throw new Error("You have already contributed to this circuit");
        }

        const circuit = await getCircuitState(id);
        const circuitConfig = config.circuits.find((c) => c.id === id);

        // Reached target while this participant was computing: signal a seamless
        // skip rather than the misleading "Not at front" they'd otherwise get
        // from the now-cleared queue. handleUpload turns thrown errors into the
        // JSON error body, so the POST catch maps this sentinel to a 409 carrying
        // the machine-readable reason the client skips on.
        if (
          circuitConfig &&
          circuit.totalContributions >= circuitConfig.targetContributions
        ) {
          throw new Error(CIRCUIT_TARGET_REACHED);
        }

        const pruned = pruneExpiredEntries(
          circuit.queue,
          config.queueTimeoutSeconds,
        );
        // Mirror the front reconcile so the upload-token gate agrees with the
        // queue/contribute front check (read-only here; those paths persist it
        // and own the no-show counting).
        const active = circuitConfig
          ? reconcileFront(pruned, {
              claimWindowSeconds: config.claimWindowSeconds,
              maxActiveSeconds: resolveMaxActiveSeconds(circuitConfig),
            }).queue
          : pruned;

        if (active[0]?.participantId !== participant.participantId) {
          throw new Error("Not at front of the queue");
        }

        return {
          allowedContentTypes: ["application/octet-stream"],
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({
            participantId: participant.participantId,
            circuitId: id,
          }),
        };
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === CIRCUIT_TARGET_REACHED) {
      return NextResponse.json(
        {
          error: "This circuit has already reached its contribution target.",
          reason: CIRCUIT_TARGET_REACHED,
        },
        { status: 409 },
      );
    }
    const status = message === "Unauthorized" ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
