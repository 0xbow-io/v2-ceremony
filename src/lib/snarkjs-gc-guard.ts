// snarkjs (via fastfile) leaves some file handles for the GC to close. On recent
// Node a GC-closed FileHandle throws an uncaught async `ERR_INVALID_STATE`,
// outside any try/catch around the snarkjs call, crashing the process mid-request
// (client sees an empty response). The ceremony scripts guard the same error.
// This handler suppresses only that benign error and re-raises everything else,
// so real bugs still crash. Idempotent: dev hot-reloads don't stack listeners.
//
// Import for side effect from any route that runs snarkjs:
//   import "@/lib/snarkjs-gc-guard";

const guarded = globalThis as typeof globalThis & {
  __cabureSnarkjsGcGuard?: boolean;
};

if (!guarded.__cabureSnarkjsGcGuard) {
  guarded.__cabureSnarkjsGcGuard = true;

  process.on("uncaughtException", (error: NodeJS.ErrnoException) => {
    if (
      error?.code === "ERR_INVALID_STATE" &&
      String(error?.message).includes("FileHandle")
    ) {
      console.warn(
        `[cabure] suppressed snarkjs/fastfile GC handle error: ${error.message}`,
      );
      return;
    }
    // Not ours: re-raise so Node applies its default fatal handling.
    throw error;
  });
}

export {};
