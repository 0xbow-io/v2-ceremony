import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    participantId: string;
    participantName: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    participantId?: string;
    participantName?: string;
    // GitHub access token (gist scope). Server-only: read via getToken in the
    // attestation route; never exposed to the client session.
    accessToken?: string;
  }
}
