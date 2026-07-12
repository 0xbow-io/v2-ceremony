"use client";

import { useQuery } from "@tanstack/react-query";

import { getParticipantEligibility } from "@/lib/api";
import { useParticipant } from "@/hooks/useParticipant";

export function useParticipantEligibility() {
  const { isAuthenticated, participantId } = useParticipant();

  const { data, isLoading } = useQuery({
    queryKey: ["participantEligibility", participantId],
    queryFn: ({ signal }) => getParticipantEligibility(signal),
    enabled: isAuthenticated,
    refetchInterval: 20_000,
  });

  return {
    eligibility: data ?? null,
    eligibilityLoading: isAuthenticated && isLoading,
  };
}
