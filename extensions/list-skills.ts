import { homedir } from "node:os";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSettings } from "./shared/settings-file.ts";
import { loadSkillCatalog } from "./list-skills/catalog.ts";
import { SkillChecklist } from "./list-skills/checklist.ts";
import { saveSkillChanges } from "./list-skills/settings.ts";

export default function (pi: ExtensionAPI) {
  const lifetime = new AbortController();
  let picking = false;
  let closePicker: (() => void) | undefined;
  let activeUI: Promise<boolean> | undefined;
  pi.on("session_shutdown", async () => {
    lifetime.abort();
    closePicker?.();
    // Keep the old UI context alive until its editor/overlay cleanup finishes.
    await activeUI?.catch(() => {});
  });
  pi.registerCommand("listskills", {
    description: "Inspect skills and change global local-skill filters (other sources are read-only)",
    handler: async (_args, ctx) => {
      if (lifetime.signal.aborted) return;
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/listskills requires an interactive terminal UI.", "warning");
        return;
      }
      if (picking) {
        ctx.ui.notify("The skill picker is already open.", "info");
        return;
      }
      picking = true;
      try {
        await ctx.waitForIdle();
        if (lifetime.signal.aborted) return;
        const agentDir = getAgentDir();
        const { skills, warnings } = loadSkillCatalog({
          agentDir, homeDir: homedir(), settings: readSettings(agentDir), commands: pi.getCommands(),
        });
        if (warnings.length) ctx.ui.notify(`Some skill paths could not be read: ${warnings[0]}`, "warning");
        let save: boolean;
        try {
          activeUI = ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
            const picker = new SkillChecklist(skills, done, () => tui.requestRender(), theme, () => tui.terminal.rows);
            closePicker = () => picker.cancel();
            if (lifetime.signal.aborted) queueMicrotask(closePicker);
            return picker;
          }, { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%" } });
          save = await activeUI;
        } finally {
          closePicker = undefined;
          activeUI = undefined;
        }
        if (lifetime.signal.aborted) return;
        if (!save) {
          ctx.ui.notify("Skill changes cancelled", "info");
          return;
        }
        const changes = skills.filter(skill => skill.managed && skill.enabled !== skill.initialEnabled);
        await saveSkillChanges(agentDir, changes, lifetime.signal);
        if (lifetime.signal.aborted) return;
        ctx.ui.notify("Saved global skill filters; reloading Pi resources…", "info");
        await ctx.reload();
        return; // Reload invalidates this extension's old context.
      } catch (error) {
        if (!lifetime.signal.aborted) {
          ctx.ui.notify(`Could not save skill selection: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      } finally {
        picking = false;
      }
    },
  });
}
