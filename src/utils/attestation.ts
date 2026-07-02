// Contributor attestation: a public, self-published record that a contribution
// happened. It is opt-in and not load-bearing. Soundness comes from the genuine
// hash chain and the open verifier; an attestation only lets a contributor who
// chooses to publish detect censorship of their own contribution (if dropped,
// their h_k does not appear in the final parameters).
//
// This is a record of hashes, NOT a signature: anyone can publish a valid-looking
// attestation for a public h_k, so a third party must not read "N attestations"
// as proof of honesty or diversity. See docs/h4-verifiability.md (§6.3).

export interface AttestationPayload {
  ceremony: string;
  circuit: string;
  // 1-based position the coordinator assigned. Informational only: a verifier
  // finds h_k's real position in the final zkey regardless of what is claimed here.
  index: number;
  // The contributor's OWN contribution hash (snarkjs hashPubKey), computed
  // client-side. This is the one value the contributor can vouch for: a verifier
  // confirms it appears in the final zkey's contribution list. Server-reported
  // values (the server's h_k, the predecessor, the chain hash) are deliberately
  // NOT included — the server can fabricate them, so they would not be the
  // contributor's own statement and add nothing a verifier can't re-derive.
  //
  // No `login` field: the contributor's identity is which GitHub account the
  // gist is published under (public + timestamped), not a self-declared string
  // in the JSON, which would be redundant and unverifiable.
  h_k: string;
}

export function buildAttestation(input: AttestationPayload): {
  payload: AttestationPayload;
  filename: string;
  json: string;
} {
  return {
    payload: input,
    filename: `cabure-attestation-${input.ceremony}-${input.circuit}-${input.index}.json`,
    json: JSON.stringify(input, null, 2),
  };
}

// Publish the attestation as a public Gist on the contributor's own GitHub
// account. One click, no copy and paste. Returns the Gist's web URL.
//
// The GitHub token is never in the client: this posts to our own server route,
// which reads the token from the session JWT and calls GitHub. Throws
// "UNAUTHORIZED" when the session has no gist-scoped token (signed in before
// the scope was granted) so the caller can prompt a fresh sign-in.
export async function publishAttestation(
  input: AttestationPayload,
): Promise<string> {
  const { filename, json } = buildAttestation(input);
  const response = await fetch("/api/ceremony/attestation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename,
      content: json,
      description: `Caburé attestation — ${input.ceremony} / ${input.circuit} #${input.index}`,
    }),
  });
  if (response.status === 401) {
    throw new Error("UNAUTHORIZED");
  }
  if (!response.ok) {
    throw new Error(`Gist creation failed (${response.status}).`);
  }
  const data = (await response.json()) as { url?: string };
  if (!data.url) {
    throw new Error("Gist was created but no URL was returned.");
  }
  return data.url;
}
