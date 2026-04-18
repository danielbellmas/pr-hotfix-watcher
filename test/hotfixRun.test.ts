import { describe, expect, it } from "vitest";
import { formatPrLabels, truncateRunLogTail } from "../src/hotfixRunHelpers";

describe("formatPrLabels", () => {
  it("formats PR numbers", () => {
    expect(formatPrLabels([1, 22])).toBe("#1, #22");
  });
});

describe("truncateRunLogTail", () => {
  it("returns short text unchanged (normalized whitespace)", () => {
    expect(truncateRunLogTail("  hello\nworld  ", 100)).toBe("hello world");
  });

  it("truncates from the left with ellipsis", () => {
    const long = "x".repeat(400);
    const out = truncateRunLogTail(long, 50);
    expect(out.length).toBeLessThanOrEqual(51);
    expect(out.startsWith("…")).toBe(true);
  });
});
