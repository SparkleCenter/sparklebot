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

const anon = readFileSync(path.join(root, 'hermes_cli/anon_auth.py'), 'utf8')
check('Nous guests are off by default', anon.includes('nous_cfg.get("guest", False)'),
  'Sparklebot would create an anonymous Nous account and route search through Nous')

let failed = 0
for (const { name, ok, hint } of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  (${hint})`}`)
  if (!ok) failed += 1
}
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll build checks passed.')
process.exit(failed ? 1 : 0)
