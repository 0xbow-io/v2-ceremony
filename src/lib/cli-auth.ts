export interface PendingDeviceAuth {
  deviceCode: string;
  interval: number;
  createdAt: number;
  lastPolledAt?: number;
  completedToken?: string;
  completedParticipantId?: string;
  completedParticipantName?: string;
  completedExpiresAt?: number;
}

export function cliLoginKey(code: string): string {
  return `cli-login:${code}`;
}
