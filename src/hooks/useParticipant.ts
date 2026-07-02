"use client";

import { useSession, signIn } from "next-auth/react";

export type AuthMethod = "github";

export function useParticipant() {
  const { data: session, status } = useSession();

  const participantId = session?.participantId ?? null;
  const participantName = session?.participantName ?? "";
  const isAuthenticated = status === "authenticated";

  const authenticate = (_method: AuthMethod) => {
    void signIn("github");
  };

  return {
    participantId,
    participantName,
    isAuthenticated,
    authenticate,
  };
}
