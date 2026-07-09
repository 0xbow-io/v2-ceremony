import { describe, expect, it } from "vitest";

import { buildCommittedZkeyPath } from "@/lib/zkey-path";

describe("committed zkey paths", () => {
  it("formats an injected contribution UUID", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const path = buildCommittedZkeyPath("ceremony/zkeys", "deposit", uuid);

    expect(path).toBe(`ceremony/zkeys/deposit/contribution-${uuid}.zkey`);
  });

  it("generates an opaque UUID by default", () => {
    expect(buildCommittedZkeyPath("ceremony/zkeys", "deposit")).toMatch(
      /^ceremony\/zkeys\/deposit\/contribution-[0-9a-f-]{36}\.zkey$/,
    );
  });
});
