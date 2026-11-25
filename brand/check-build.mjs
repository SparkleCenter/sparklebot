// Checks a finished Sparklebot build for what the eye catches first. Run after a build, by
// brand/build-local.ps1 and by the nightly update recipe. Exit 1 on any failure.
//
//   node brand/check-build.mjs [path-to-win-unpacked]
//
// Each check exists because it once went wrong:
// - the shortcut icon: Windows caches icons by file path, so a PC that had Hermes kept showing
//   Hermes's picture when the Sparkle icon used Hermes's file name (25.11.2026);
// - the Nous account: Hermes creates an anonymous Nous account by default.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const brand = JSON.parse(readFileSync(path.join(root, 'brand/sparklebot.json'), 'utf8')).product
const unpacked = path.resolve(process.argv[2] || path.join(root, 'apps/desktop/release/win-unpacked'))
const sparkleIcon = readFileSync(path.join(root, 'brand/icons/apps/desktop/assets/icon.ico'))

const checks = []
const check = (name, ok, hint) => checks.push({ name, ok: Boolean(ok), hint })

const exe = path.join(unpacked, `${brand.display}.exe`)
check(`${brand.display}.exe exists`, existsSync(exe), 'the build did not produce the branded app')
check('no Hermes.exe left', !existsSync(path.join(unpacked, 'Hermes.exe')), 'the app name came from Hermes again')

const ico = path.join(unpacked, 'resources', `${brand.kebab}.ico`)
check(`resources/${brand.kebab}.ico is the Sparkle icon`, existsSync(ico) && readFileSync(ico).equals(sparkleIcon),
  'shortcuts would show a wrong or missing icon')
check('no resources/icon.ico (Hermes\'s cached path)', !existsSync(path.join(unpacked, 'resources', 'icon.ico')),
  'Windows would show the cached Hermes icon on PCs that had Hermes')

// The default that load_config() starts from decides it, not only the fallback in anon_auth.py.
const anon = readFileSync(path.join(root, 'hermes_cli/anon_auth.py'), 'utf8')
const defaults = readFileSync(path.join(root, 'hermes_cli/config_defaults.py'), 'utf8')
check('Nous guests are off by default', anon.includes('nous_cfg.get("guest", False)') &&
  /"guest":\s*False/.test(defaults) && !/"guest":\s*True/.test(defaults),
  'Sparklebot would create an anonymous Nous account and route search through Nous')
check('Foundry prices can be set (model_pricing)',
  readFileSync(path.join(root, 'agent/usage_pricing.py'), 'utf8').includes('_user_pricing_override'),
  'spending on Azure Foundry would show as unknown / $0')

// Window behaviour Omar asked for (25.11.2026): starts with Windows and closes to the tray by default.
const mainTs = readFileSync(path.join(root, 'apps/desktop/electron/main.ts'), 'utf8')
const trayTs = readFileSync(path.join(root, 'apps/desktop/electron/minimize-to-tray.ts'), 'utf8')
check('starts with Windows by default (switch in Settings)', mainTs.includes('startAtLogin.start()') &&
  existsSync(path.join(root, 'apps/desktop/electron/start-at-login.ts')),
  'the app would not start when the PC starts')
check('X closes to the tray by default', trayTs.includes('.enabled !== false'),
  'closing the window would quit the app instead of keeping it in the tray')

let failed = 0
for (const { name, ok, hint } of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  (${hint})`}`)
  if (!ok) failed += 1
}
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll build checks passed.')
process.exit(failed ? 1 : 0)
