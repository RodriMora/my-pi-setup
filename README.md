# my-pi-setup

Rodri's personal pi package: extensions, skills, and themes, all in one place. Published publicly at `github.com/RodriMora/my-pi-setup`.

## Layout

- `extensions/` — pi extensions (auto-discovered when this folder is loaded as a package)
- `skills/` — pi skills (add `SKILL.md` folders here)
- `themes/` — pi themes (add `.json` theme files here)

## Loading locally

This folder is registered in `~/.pi/agent/settings.json` under `packages` as a local path, so any new `.ts` file dropped in `extensions/` is picked up automatically on `/reload`.

## Publishing

This folder is already a git repo with `origin` set to the public GitHub repo:

```bash
# push the latest local state
git add -A && git commit -m "wip"
git push -u origin main
```

On another machine, install directly from the repo:

```bash
pi install git:github.com/RodriMora/my-pi-setup
```
