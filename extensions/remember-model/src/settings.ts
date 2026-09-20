import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { updateSettings } from "../../shared/settings-file.ts";

export interface DefaultSettingsPatch {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevel;
}

/** Merge only defaults, preserving unrelated settings and coordinating with Pi's writer. */
export async function updateDefaultSettings(
	agentDir: string,
	patch: DefaultSettingsPatch,
	signal?: AbortSignal,
): Promise<void> {
	return updateSettings(agentDir, (current) => {
		if (Object.entries(patch).every(([key, value]) => current[key] === value)) return undefined;
		return { ...current, ...patch };
	}, signal);
}
