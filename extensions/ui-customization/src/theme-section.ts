import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

/**
 * Unsupported compatibility shim for Pi 0.84/0.85's loaded-resource listing.
 * Both renderers retain document = [header, resources, chat] at children[0].
 * Anchor by OUR header's object identity, never by rendered ancestor text.
 * Unknown layouts/classes fail closed: leaving Themes visible is harmless.
 */
export function hideLoadedThemes(tui: object, ownHeader: Component): boolean {
  try {
    const roots: unknown = Reflect.get(tui, "children");
    if (!Array.isArray(roots)) return false;
    const document: unknown = roots[0];
    if (!(document instanceof Container) || document.children.length !== 3) return false;
    const [header, resources, chat] = document.children;
    if (!(header instanceof Container) || !header.children.includes(ownHeader) ||
        !(resources instanceof Container) || !(chat instanceof Container) ||
        new Set([document, header, resources, chat]).size !== 4) return false;

    // A resource section is a leaf Text, not a message/container. Do not descend
    // into anything here (especially not the neighboring transcript).
    const children = resources.children;
    if (Object.isFrozen(children) || !children.every(child =>
      (child instanceof Text || child instanceof Spacer) && !("children" in child),
    )) return false;
    const themes = children.filter(child =>
      child instanceof Text &&
      "setExpanded" in child && typeof child.setExpanded === "function" &&
      child.render(200).map(line => stripVTControlCharacters(line).trim())
        .find(line => line.length > 0) === "[Themes]",
    );
    if (themes.length !== 1) return false;
    const section = themes[0]!;
    const next = children[children.indexOf(section) + 1];
    resources.removeChild(section);
    if (next instanceof Spacer) resources.removeChild(next);
    resources.invalidate();
    return true;
  } catch {
    // An upstream private-layout change must never break the conversation UI.
    return false;
  }
}
