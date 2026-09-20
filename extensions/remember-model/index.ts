/**
 * remember-model - persists the last selected model as the default.
 *
 * Whenever the model changes via /model or Ctrl+P cycling, writes
 * defaultProvider/defaultModel (and defaultThinkingLevel) back to
 * Pi's configured agent directory so the next session starts on the same model.
 *
 * Model changes with source "restore" are ignored: those are session
 * startups, not user choices, and skipping them avoids touching
 * settings.json on every launch.
 */

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { updateDefaultSettings, type DefaultSettingsPatch } from "./src/settings.ts";

export default function (pi: ExtensionAPI) {
	const shutdown = new AbortController();
	let saveQueue = Promise.resolve();
	const persist = (patch: DefaultSettingsPatch) => {
		const agentDir = getAgentDir();
		// Preserve selection order even if an earlier save is waiting on another process.
		const save = saveQueue.then(() => updateDefaultSettings(agentDir, patch, shutdown.signal));
		saveQueue = save.catch(() => {});
		return save;
	};
	pi.on("session_shutdown", () => shutdown.abort());
	pi.on("model_select", async (event, ctx) => {
		if (event.source === "restore") return;

		const { model } = event;
		try {
			await persist({
				defaultProvider: model.provider,
				defaultModel: model.id,
			});
			if (shutdown.signal.aborted) return;
			ctx.ui.setStatus("remember-model", `${model.provider}/${model.id}`);
		} catch (err) {
			if (shutdown.signal.aborted) return;
			ctx.ui.notify(
				`remember-model: failed to persist default model: ${err}`,
				"warning",
			);
		}
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		try {
			await persist({ defaultThinkingLevel: event.level });
		} catch (err) {
			if (shutdown.signal.aborted) return;
			ctx.ui.notify(
				`remember-model: failed to persist thinking level: ${err}`,
				"warning",
			);
		}
	});
}
