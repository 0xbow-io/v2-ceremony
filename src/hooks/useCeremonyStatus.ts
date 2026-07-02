"use client";

import { useQuery } from "@tanstack/react-query";
import { getStatus } from "@/lib/api";

export function useCeremonyStatus(pollIntervalMs = 10_000) {
  const { data: status, error } = useQuery({
    queryKey: ["ceremonyStatus"],
    queryFn: ({ signal }) => getStatus(signal),
    refetchInterval: pollIntervalMs,
  });

  return {
    status: status ?? null,
    statusError: error ? error.message : null,
  };
}
