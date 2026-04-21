import { describe, expect, it } from "vitest";
import {
  buildHotfixCliSuffix,
  normalizeHotfixCliOptions,
} from "../src/hotfixCli";

const defaults = {
  env: "pre" as const,
  draft: false,
  criticalFastTrack: false,
  deploy: false,
};

describe("buildHotfixCliSuffix", () => {
  it("always includes --env", () => {
    expect(buildHotfixCliSuffix(defaults)).toBe("--env pre");
    expect(
      buildHotfixCliSuffix({
        env: "prod",
        draft: false,
        criticalFastTrack: false,
        deploy: false,
      })
    ).toBe("--env prod");
    expect(
      buildHotfixCliSuffix({
        env: "both",
        draft: false,
        criticalFastTrack: false,
        deploy: false,
      })
    ).toBe("--env pre --env prod");
  });

  it("adds --draft when enabled", () => {
    expect(
      buildHotfixCliSuffix({
        env: "pre",
        draft: true,
        criticalFastTrack: false,
        deploy: false,
      })
    ).toBe("--env pre --draft");
  });

  it("adds --critical-fast-track when enabled", () => {
    expect(
      buildHotfixCliSuffix({
        env: "pre",
        draft: false,
        criticalFastTrack: true,
        deploy: false,
      })
    ).toBe("--env pre --critical-fast-track");
  });

  it("combines flags", () => {
    expect(
      buildHotfixCliSuffix({
        env: "prod",
        draft: true,
        criticalFastTrack: true,
        deploy: false,
      })
    ).toBe("--env prod --draft --critical-fast-track");
    expect(
      buildHotfixCliSuffix({
        env: "both",
        draft: true,
        criticalFastTrack: false,
        deploy: false,
      })
    ).toBe("--env pre --env prod --draft");
  });

  it("does NOT include --deploy (deploy is an extension-side flag)", () => {
    expect(
      buildHotfixCliSuffix({
        env: "pre",
        draft: false,
        criticalFastTrack: false,
        deploy: true,
      })
    ).toBe("--env pre");
    expect(
      buildHotfixCliSuffix({
        env: "both",
        draft: true,
        criticalFastTrack: true,
        deploy: true,
      })
    ).toBe("--env pre --env prod --draft --critical-fast-track");
  });
});

describe("normalizeHotfixCliOptions", () => {
  it("fills from defaults when partial missing", () => {
    expect(normalizeHotfixCliOptions(undefined, defaults)).toEqual(defaults);
    expect(normalizeHotfixCliOptions({}, defaults)).toEqual(defaults);
  });

  it("accepts valid env and booleans", () => {
    expect(
      normalizeHotfixCliOptions({ env: "prod", draft: true }, defaults)
    ).toEqual({
      env: "prod",
      draft: true,
      criticalFastTrack: false,
      deploy: false,
    });
    expect(normalizeHotfixCliOptions({ env: "both" }, defaults)).toEqual({
      env: "both",
      draft: false,
      criticalFastTrack: false,
      deploy: false,
    });
  });

  it("normalizes deploy from persisted state", () => {
    expect(normalizeHotfixCliOptions({ deploy: true }, defaults)).toEqual({
      ...defaults,
      deploy: true,
    });
    expect(
      normalizeHotfixCliOptions(
        // @ts-expect-error persisted garbage
        { deploy: "yes" },
        defaults
      )
    ).toEqual(defaults);
  });

  it("rejects invalid env", () => {
    // @ts-expect-error deliberate bad value from persisted state
    expect(normalizeHotfixCliOptions({ env: "staging" }, defaults)).toEqual(
      defaults
    );
  });

  it("ignores non-boolean draft and criticalFastTrack from bad persisted JSON", () => {
    expect(
      normalizeHotfixCliOptions(
        // @ts-expect-error persisted garbage
        { draft: "yes", criticalFastTrack: 1 },
        defaults
      )
    ).toEqual(defaults);
  });
});
