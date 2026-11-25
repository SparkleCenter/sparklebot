# Sparklebot brand overlay

Sparklebot is Hermes Agent (Nous Research, MIT licence) with Sparkle's name and icon on the outside. The engine is
unchanged. Plan and decisions: `C:\dev\sparkle-intelligence\docs\SPARKLE_BOT_PLAN.md` (sections 4–7).

The repository is Hermes Agent **v0.23.2** (commit `ae2a81c`) plus this `brand/` folder and the files the
overlay changes.

## Files

| File | What it does |
|---|---|
| `sparklebot.json` | The brand values: names, app ID `ee.sparklesolutions.sparklebot`, author, icon source. Change values here only |
| `source/sparkle-icon-512.png` | The Sparkle mark, copied from `sparkle-website/public/icon-512.png` |
| `make_icons.py` | Makes the Sparkle version of every Hermes icon file (same names and sizes) into `icons/` |
| `icons/` | Generated. 72 files: app icon, Windows tiles, in-app badge |
| `apply.mjs` | Writes the names and icons into the checkout. Every text edit names the exact Hermes text it replaces; if Hermes moved it, it stops before writing anything. `--check` only reports |
| `build-local.ps1` | Builds an unsigned test app for this PC: `apps\desktop\release\win-unpacked\Sparklebot.exe` |
| `README.public.md` | The repository's front page; the overlay copies it to `README.md` |

## What the overlay changes

| Where | Hermes | Sparklebot |
|---|---|---|
| `apps/desktop/product-identity.cjs` | Hermes, `com.nousresearch.hermes`, `NousResearch.Hermes` | Sparklebot, `ee.sparklesolutions.sparklebot`, `SparkleSolutions.Sparklebot` |
| same file | Store builds use Nous's Store identity | Store builds refused until Sparkle has its own |
| `apps/desktop/package.json` | productName Hermes, author Nous Research | Sparklebot, SparkleSolutions OÜ; description says "built on Hermes Agent by Nous Research (MIT licence)" |
| `apps/desktop/index.html` | window title Hermes | Sparklebot |
| `apps/desktop/assets/**`, `public/apple-touch-icon.png`, `public/nous-girl*.png` | Hermes icons | Sparkle mark |

Stays Hermes on purpose: the `hermes` command, the `@hermes` handle, `LICENSE`, and the engine.

Not done yet: the About text, colours (skin), the in-app `hermes.png` / `hermes-sprite.png` / `hermes-frames`
artwork, macOS `icon.icon`, signing, installer, update feed.

## Rebuild

```powershell
python -I brand\make_icons.py        # only when the icon source or Hermes's icon list changes
node brand\apply.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File brand\build-local.ps1
```

## How the test app relates to the live Hermes

The packaged app finds its engine and bots in `%LOCALAPPDATA%\hermes`, the same place the Hermes app uses, so
on a PC that already runs Hermes it shows the same bots. Its own window settings live in `%APPDATA%\Sparklebot`,
apart from Hermes's. Close the Hermes app before opening a locally built Sparklebot. Until that PC's engine is
installed from this repository, do not press "Update" inside a locally built Sparklebot: the source updater
would update the existing Hermes checkout.

## Undo a local test build

Delete the build folder and `%APPDATA%\Sparklebot`. The engine in `%LOCALAPPDATA%\hermes` is not touched by a
local build.
