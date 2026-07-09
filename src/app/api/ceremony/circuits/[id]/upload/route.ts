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
        const pruned = pruneExpiredEntries(
          circuit.queue,
          config.queueTimeoutSeconds,
        );
        // Mirror the front reconcile so the upload-token gate agrees with the
        // queue/contribute front check (read-only here; those paths persist it
        // and own the no-show counting).
        const circuitConfig = config.circuits.find((c) => c.id === id);
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
    const status = message === "Unauthorized" ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
