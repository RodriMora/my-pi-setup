import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { getSessionCost, titleRecord, titleRequestHash, usageCost, TITLE_ENTRY_TYPE } from "./src/session-cost.ts";

const entries = (...values: unknown[]) => values as SessionEntry[];
const title = (data: unknown) => entries({ type: "custom", customType: TITLE_ENTRY_TYPE, data })[0]!;
const valid = { version: 1, requestHash: titleRequestHash("request"), summary: "Topic", cost: .25 };

describe("recorded spending validation", () => {
  it.each([undefined, null, {}, { cost: null }, { cost: { total: "1" } },
    { cost: { total: -1 } }, { cost: { total: NaN } }, { cost: { total: Infinity } },
  ])("invalid usage contributes zero: %j", value => {
    expect(usageCost(value)).toBe(0);
    expect(getSessionCost(entries(
      { type: "message", message: { role: "assistant", usage: value } },
      { type: "message", message: { role: "toolResult", usage: value } },
      { type: "compaction", usage: value }, { type: "branch_summary", usage: value },
    ))).toBe(0);
  });

  it("uses the reported total, without summing its components again", () => {
    expect(usageCost({ cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } })).toBe(10);
  });

  it("ignores unrelated custom data and message roles", () => {
    expect(getSessionCost(entries(
      { type: "custom", customType: "other-extension", data: valid },
      { type: "message", message: { role: "user", usage: { cost: { total: 99 } } } },
      { type: "message", message: { role: "bashExecution", usage: { cost: { total: 99 } } } },
    ))).toBe(0);
  });

  it("accepts only supported, well-formed title metadata", () => {
    expect(titleRecord(title(valid))).toEqual(valid);
    for (const value of [null, [], "bad", 42, { ...valid, version: 2 },
      { ...valid, requestHash: "unversioned" }, { ...valid, summary: "x".repeat(40) },
      { ...valid, summary: [] }, { ...valid, cost: -1 }, { ...valid, cost: NaN },
      { ...valid, cost: Infinity }, { ...valid, cost: "0.25" },
    ]) {
      expect(titleRecord(title(value))).toBeUndefined();
      expect(getSessionCost([title(value)])).toBe(0);
    }
  });

  it("cost-only empty title attempts remain valid billable records", () => {
    expect(getSessionCost([title({ ...valid, summary: null })])).toBe(.25);
  });

  it("a corrupt extreme value cannot overflow the published total to Infinity", () => {
    const record = title({ ...valid, cost: Number.MAX_VALUE });
    expect(Number.isFinite(getSessionCost([record, record]))).toBe(true);
  });
});
