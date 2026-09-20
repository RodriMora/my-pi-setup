import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const TITLE_ENTRY_TYPE = "model-info:title";
export const TITLE_REQUEST_CHAR_LIMIT = 8_000;
export const TITLE_CHAR_LIMIT = 39;
export interface TitleRecord {
  version: 1;
  requestHash: string;
  summary: string | null;
  cost: number;
  attemptId?: string;
}

export function titleRequestHash(text: string) {
  return createHash("sha256").update(`v1\0${text.slice(0, TITLE_REQUEST_CHAR_LIMIT)}`).digest("hex");
}

export function usageCost(usage: unknown): number {
  if (!usage || typeof usage !== "object" || !("cost" in usage)) return 0;
  const cost = usage.cost;
  if (!cost || typeof cost !== "object" || !("total" in cost)) return 0;
  return typeof cost.total === "number" && Number.isFinite(cost.total) && cost.total >= 0 ? cost.total : 0;
}

export function titleRecord(entry: SessionEntry): TitleRecord | undefined {
  if (entry.type !== "custom" || entry.customType !== TITLE_ENTRY_TYPE) return;
  const data = entry.data as Partial<TitleRecord> | undefined;
  if (!data || data.version !== 1 || typeof data.requestHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(data.requestHash) ||
      !(data.summary === null || (typeof data.summary === "string" && data.summary.length <= TITLE_CHAR_LIMIT)) ||
      typeof data.cost !== "number" || !Number.isFinite(data.cost) || data.cost < 0) return;
  return data as TitleRecord;
}

/** Whole-session recorded spending, including abandoned/compacted branches. */
export function getSessionCost(entries: readonly SessionEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    let cost = 0;
    if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
      cost = usageCost(entry.message.usage);
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      cost = usageCost(entry.usage);
    } else {
      cost = titleRecord(entry)?.cost ?? 0;
    }
    if (Number.isFinite(total + cost)) total += cost;
  }
  return total;
}
