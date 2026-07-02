const REQUIRED_SERVER_VARS = [
  "BLOB_READ_WRITE_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "NEXTAUTH_SECRET",
  "NEXTAUTH_URL",
] as const;

type EnvKey = (typeof REQUIRED_SERVER_VARS)[number];

function validateEnv(): Record<EnvKey, string> {
  const missing = REQUIRED_SERVER_VARS.filter((k) => !process.env[k]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `
      
   Missing required environment variables:\n${missing.map((k) => `   - ${k}`).join("\n")}\n` +
        `   Copy .env.example to .env and fill in the values.\n`,
    );
  }
  return Object.fromEntries(
    REQUIRED_SERVER_VARS.map((k) => [k, process.env[k]!.trim()]),
  ) as Record<EnvKey, string>;
}

export const env = validateEnv();
