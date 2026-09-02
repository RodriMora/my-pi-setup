/**
 * remember-model - persists the last selected model as the default.
 *
 * Whenever the model changes via /model or Ctrl+P cycling, writes
 * defaultProvider/defaultModel (and defaultThinkingLevel) back to
 * ~/.pi/agent/settings.json so the next session starts on the same model.
 *
 * Model changes with source "restore" are ignored: those are session
 * startups, not user choices, and skipping them avoids touching
 * settings.json on every launch.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

function updateSettings(patch: Record<string, unknown>): void {
	let settings: Record<string, unknown> = {};
	try {
		settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<
			string,
			unknown
		>;
	} catch {
		// Unreadable/corrupt settings: start from a fresh object rather than fail.
	}
	const next = { ...settings, ...patch };
	// Atomic write so a crash mid-write can't corrupt settings.json.
	const tmp = `${SETTINGS_PATH}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
	renameSync(tmp, SETTINGS_PATH);
}

export default function (pi: ExtensionAPI) {
	pi.on("model_select", async (event, ctx) => {
		if (event.source === "restore") return;

		const { model } = event;
		try {
			updateSettings({
				defaultProvider: model.provider,
				defaultModel: model.id,
			});
			ctx.ui.setStatus("remember-model", `${model.provider}/${model.id}`);
		} catch (err) {
			ctx.ui.notify(
				`remember-model: failed to persist default model: ${err}`,
				"warning",
			);
		}
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		try {
			updateSettings({ defaultThinkingLevel: event.level });
		} catch (err) {
			ctx.ui.notify(
				`remember-model: failed to persist thinking level: ${err}`,
				"warning",
			);
		}
	});
}
