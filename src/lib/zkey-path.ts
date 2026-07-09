export function buildCommittedZkeyPath(
  zkeyPrefix: string,
  circuitId: string,
  uuid: string = crypto.randomUUID(),
): string {
  return `${zkeyPrefix}/${circuitId}/contribution-${uuid}.zkey`;
}
