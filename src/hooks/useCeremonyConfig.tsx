"use client";

import { createContext, useContext } from "react";

import { getClientConfig, type ClientCeremonyConfig } from "@/lib/ceremony-config";

const CeremonyConfigContext = createContext<ClientCeremonyConfig | null>(null);

const clientConfig = getClientConfig();

export function CeremonyConfigProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <CeremonyConfigContext.Provider value={clientConfig}>
      {children}
    </CeremonyConfigContext.Provider>
  );
}

export function useCeremonyConfig(): ClientCeremonyConfig {
  const ctx = useContext(CeremonyConfigContext);
  if (!ctx) {
    throw new Error(
      "useCeremonyConfig must be used within CeremonyConfigProvider",
    );
  }
  return ctx;
}
