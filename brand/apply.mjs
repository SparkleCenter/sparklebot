// Sparklebot brand overlay for a Hermes Agent checkout.
//
// Writes the values in brand/sparklebot.json and the icons in brand/icons/ into this
// checkout. Every text change names the exact Hermes text it replaces. If Hermes moved or
// rewrote that text, the overlay stops before writing anything, so a new Hermes version
// can never ship half-branded.
//
//   node brand/apply.mjs           apply (safe to run again)
//   node brand/apply.mjs --check   only report; exit 1 if anything is not branded yet
//
// Outside only: names, icons, window title, package metadata. The engine, the `hermes`
// command and the `@hermes` handle stay as Hermes, as the plan decides.

import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const checkOnly = process.argv.includes('--check')
const brand = JSON.parse(readFileSync(path.join(root, 'brand/sparklebot.json'), 'utf8'))
const p = brand.product
const theme = JSON.parse(readFileSync(path.join(root, 'brand/theme.json'), 'utf8'))
const paletteTs = colors => Object.entries(colors).map(([k, v]) => `      ${k}: '${v}'`).join(',\n')
const themePaletteBlock =
  `  ${theme.name}: {\n    colors: {\n${paletteTs(theme.colors)}\n    },\n    darkColors: {\n${paletteTs(theme.darkColors)}\n    }\n  },\n`
const themePresetBlock =
  `/** ${theme.label}: Sparklebot's default skin (brand/theme.json). */\n` +
  `export const ${theme.name}Theme: DesktopTheme = {\n  name: '${theme.name}',\n  label: '${theme.label}',\n` +
  `  description: '${theme.description}',\n  ...THEME_PRESET_PALETTES.${theme.name},\n` +
  `  typography: { fontSans: SYSTEM_SANS, fontMono: SYSTEM_MONO }\n}\n\n`

/** The avatar layer, from brand/theme.json (avatarColors, avatarShapes). */
function avatarEdits() {
  const av = theme.avatarShapes
  const AV = 'apps/desktop/src/plugins/hermes-bots/avatar.tsx'
  const list = xs => xs.map(x => `'${x}'`).join(', ')
  // New outline rings in Hermes's polar form: radius by angle around (20,20); eyes sit at r≈5.4.
  const rings = [
    "    } else if (kind === 'spark') {",
    '      // Sparkle: four points, two long diagonal arms (up-right, down-left), like the Sparkle mark.',
    '      const arm = (x: number, p: number) => Math.max(0, x) ** p',
    '      rx = ry = 8.8 + 9.6 * arm(Math.cos(a + Math.PI / 3), 22) + 9.6 * arm(Math.cos(a - (2 * Math.PI) / 3), 22) +',
    '        5.6 * arm(Math.cos(a - Math.PI / 6), 26) + 5.6 * arm(Math.cos(a - (7 * Math.PI) / 6), 26)',
    "    } else if (kind === 'bubble') {",
    '      // Speech bubble with a tail down-left.',
    '      const tail = 7 * Math.max(0, Math.cos(a - (3 * Math.PI) / 4)) ** 40',
    '      rx = 16.6 + tail',
    '      ry = 14.4 + tail',
    "    } else if (kind === 'sun') {",
    '      rx = ry = 14.8 + 2.4 * Math.cos(10 * a)',
    "    } else if (kind === 'star') {",
    '      rx = ry = 12.5 + 5 * Math.cos(5 * (a + Math.PI / 2))',
    "    } else if (kind === 'cookie') {",
    '      rx = ry = 15.6 + 0.9 * Math.sin(9 * a) + 0.5 * Math.cos(4 * a)',
    "    } else if (kind === 'pebble') {"
  ].join('\n')
  return [
    {
      file: AV,
      from: "const AVATAR_SHAPES: AvatarShape[] = ['circle', 'squircle', 'pill', 'triangle', 'hexagon', 'cloud', 'drop']\nexport const AVATAR_PICKER_SHAPES = ['circle', 'blob', 'squircle', 'pill', 'triangle', 'hexagon', 'cloud', 'drop']",
      to: `const AVATAR_SHAPES: AvatarShape[] = [${list(av.pool)}] as AvatarShape[]\nexport const AVATAR_PICKER_SHAPES = [${list(av.picker)}]\n/** Sparklebot: known bots wear their character. */\nconst NAMED_SHAPES: Record<string, string> = ${JSON.stringify(av.named)}`
    },
    {
      file: AV,
      from: 'export function defaultShapeFor(name: string): AvatarShape {\n  let hash = 0',
      to: 'export function defaultShapeFor(name: string): AvatarShape {\n  const named = NAMED_SHAPES[(name || \'\').trim().toLowerCase()]\n\n  if (named) {\n    return named as AvatarShape\n  }\n\n  let hash = 0'
    },
    { file: AV, from: "    } else if (kind === 'pebble') {", to: rings },
    { file: AV, from: "const PRIMARY_AVATAR_COLOR = '#8b5cf6'", to: `const PRIMARY_AVATAR_COLOR = '${av.primary.color}'` },
    { file: AV, from: "      shape: 'squircle',\n      color: PRIMARY_AVATAR_COLOR,", to: `      shape: '${av.primary.shape}',\n      color: PRIMARY_AVATAR_COLOR,` },
    {
      // A thin ink line around every face body, for the hand-drawn Sparks look.
      file: AV,
      from: '        data-hb-body="1"\n        fill={color}\n      />',
      to: '        data-hb-body="1"\n        fill={color}\n        stroke="rgba(42,31,22,0.78)"\n        strokeLinejoin="round"\n        strokeWidth={1.15}\n      />'
    },
    {
      // New bots start as the pebble, and the name-driven blob library (its own palette) moves last.
      file: 'apps/desktop/src/plugins/hermes-bots/create-dialog.tsx',
      all: true,
      from: "setShape(blobatarSvg ? 'blobatar' : 'circle')",
      to: `setShape('${av.newBot}')`
    },
    {
      file: 'apps/desktop/src/plugins/hermes-bots/create-dialog.tsx',
      from: "useState(blobatarSvg ? 'blobatar' : 'circle')",
      to: `useState('${av.newBot}')`
    },
    {
      file: 'apps/desktop/src/plugins/hermes-bots/avatar-picker.tsx',
      from: "{(blobatarSvg ? ['blobatar', ...AVATAR_PICKER_SHAPES] : AVATAR_PICKER_SHAPES).map(s => (",
      to: "{(blobatarSvg ? [...AVATAR_PICKER_SHAPES, 'blobatar'] : AVATAR_PICKER_SHAPES).map(s => ("
    },
    {
      // Identity colours everywhere (bots, profile tags, projects, badges): the warm palette.
      file: 'apps/desktop/src/lib/profile-color.ts',
      from: 'const PROFILE_TAG_LIGHTNESS = 58\n',
      to: `const PROFILE_TAG_LIGHTNESS = 58\n/** Sparklebot's warm identity palette (brand/theme.json avatarColors). */\nconst SPARKLE_WARM: readonly string[] = ${JSON.stringify(theme.avatarColors)}\n`
    },
    {
      file: 'apps/desktop/src/lib/profile-color.ts',
      from: '  const hue = hashString(key) % 360\n\n  return `hsl(${hue} ${PROFILE_TAG_SATURATION}% ${PROFILE_TAG_LIGHTNESS}%)`',
      to: '  return SPARKLE_WARM[hashString(key) % SPARKLE_WARM.length]'
    },
    {
      file: 'apps/desktop/src/lib/profile-color.ts',
      from: 'export const PROFILE_SWATCHES: readonly string[] = Array.from(\n  { length: 12 },\n  (_, index) => `hsl(${index * 30} ${PROFILE_TAG_SATURATION}% ${PROFILE_TAG_LIGHTNESS}%)`\n)',
      to: 'export const PROFILE_SWATCHES: readonly string[] = SPARKLE_WARM'
    }
  ]
}

/** Each edit: file, the exact Hermes text, and our text. */
const edits = [
  {
    file: 'apps/desktop/product-identity.cjs',
    from: "  '': { display: 'Hermes', kebab: 'hermes', pascal: 'Hermes' },",
    to: `  '': { display: '${p.display}', kebab: '${p.kebab}', pascal: '${p.pascal}' },`
  },
  {
    file: 'apps/desktop/product-identity.cjs',
    from: "  light: {\n    display: 'Hermes Light',\n    kebab: 'hermes-light',\n    pascal: 'HermesLight'\n  },",
    to: `  light: {\n    display: '${p.lightDisplay}',\n    kebab: '${p.lightKebab}',\n    pascal: '${p.lightPascal}'\n  },`
  },
  {
    file: 'apps/desktop/product-identity.cjs',
    from: "  bundled: {\n    display: 'Hermes Agent',\n    kebab: 'hermes-bundled',\n    pascal: 'HermesBundled'\n  }",
    to: `  bundled: {\n    display: '${p.bundledDisplay}',\n    kebab: '${p.bundledKebab}',\n    pascal: '${p.bundledPascal}'\n  }`
  },
  {
    file: 'apps/desktop/product-identity.cjs',
    from: '  appId: `com.nousresearch.${name.kebab}${kebabSuffix}`,',
    to: '  appId: `' + p.appIdPrefix + '${name.kebab}${kebabSuffix}`,'
  },
  {
    file: 'apps/desktop/product-identity.cjs',
    from: '  msixAppIdWithOrg: `NousResearch.${name.pascal}${pascalSuffix}`,',
    to: '  msixAppIdWithOrg: `' + p.msixOrgPrefix + '${name.pascal}${pascalSuffix}`,'
  },
  {
    // The Store identity below belongs to Nous. Refuse Store builds until Sparkle has its own.
    file: 'apps/desktop/product-identity.cjs',
    from: "const store = variant === 'store'\n",
    to: "const store = variant === 'store'\nif (store) throw new Error('Sparklebot has no Microsoft Store identity yet (brand/apply.mjs)')\n"
  },
  {
    // Electron names the app, its settings folder and its single-instance lock from this.
    file: 'apps/desktop/package.json',
    from: '  "productName": "Hermes",',
    to: `  "productName": "${p.display}",`
  },
  {
    file: 'apps/desktop/package.json',
    from: '  "description": "Native desktop shell for Hermes Agent.",',
    to: `  "description": ${JSON.stringify(p.description)},`
  },
  {
    file: 'apps/desktop/package.json',
    from: '  "author": "Nous Research",',
    to: `  "author": ${JSON.stringify(p.author)},`
  },
  {
    file: 'apps/desktop/index.html',
    from: '    <title>Hermes</title>',
    to: `    <title>${p.display}</title>`
  },
  {
    // Windows groups taskbar buttons by this ID. Hermes hard-codes its own, which made Windows
    // show the Hermes shortcut's icon for Sparklebot's window.
    file: 'apps/desktop/electron/main.ts',
    from: "  app.setAppUserModelId(IDENTITY_APP_NAME ? PRODUCT_IDENTITY.appId : 'com.nousresearch.hermes')",
    to: '  app.setAppUserModelId(PRODUCT_IDENTITY.appId)'
  },
  // Windows message boxes, tray menu and the quit box.
  { file: 'apps/desktop/electron/main.ts', all: true, from: "    title: 'Hermes',", to: `    title: '${p.display}',` },
  { file: 'apps/desktop/electron/main.ts', from: "title: 'Hermes desktop UI was terminated',", to: `title: '${p.display} was terminated',` },
  { file: 'apps/desktop/electron/challenge-window.ts', from: "title: 'Hermes — quick check',", to: `title: '${p.display} — quick check',` },
  { file: 'apps/desktop/electron/update-handoff-report.ts', all: true, from: "title: 'Hermes update',", to: `title: '${p.display} update',` },
  { file: 'apps/desktop/electron/minimize-to-tray.ts', from: "{ label: 'Show Hermes', click: restore },", to: `{ label: 'Show ${p.display}', click: restore },` },
  { file: 'apps/desktop/electron/minimize-to-tray.ts', from: "{ label: 'Quit Hermes', click: () => app.quit() }", to: `{ label: 'Quit ${p.display}', click: () => app.quit() }` },
  {
    file: 'apps/desktop/electron/quit-guard.ts',
    from: "Quitting only closes Hermes on this computer;",
    to: `Quitting only closes ${p.display} on this computer;`
  },
  {
    file: 'apps/desktop/electron/quit-guard.ts',
    from: "message: work.count === 1 ? 'Hermes is still working on 1 chat.' : `Hermes is still working on ${work.count} chats.`",
    to: `message: work.count === 1 ? '${p.display} is still working on 1 chat.' : \`${p.display} is still working on \${work.count} chats.\``
  },
  // The one-command installer: install from Sparkle's repository, find Sparklebot.exe, name the shortcuts.
  {
    file: 'scripts/install.ps1',
    from: '$RepoUrl = if ($env:HERMES_REPO_URL) { $env:HERMES_REPO_URL } else { "https://github.com/NousResearch/hermes-agent.git" }',
    to: `$RepoUrl = if ($env:HERMES_REPO_URL) { $env:HERMES_REPO_URL } else { "${brand.repository}.git" }`
  },
  { file: 'scripts/install.ps1', all: true, from: '-unpacked\\Hermes.exe"),', to: `-unpacked\\${p.display}.exe"),` },
  { file: 'scripts/install.ps1', from: '(Join-Path $desktopDir "release\\win-arm64-unpacked\\Hermes.exe")', to: `(Join-Path $desktopDir "release\\win-arm64-unpacked\\${p.display}.exe")` },
  { file: 'scripts/install.ps1', all: true, from: "'Hermes.lnk')", to: `'${p.display}.lnk')` },
  // No Nous by default: no anonymous Nous account, no Nous free trial, no Nous connector guest.
  // `nous.guest: true` in config.yaml still turns it on. Without it, web search uses a Brave key
  // when one is set, else Hermes's keyless free services; the Nous status item hides itself.
  {
    file: 'hermes_cli/anon_auth.py',
    from: '    if not isinstance(nous_cfg, dict):\n        return True\n    return bool(nous_cfg.get("guest", True))',
    to: '    if not isinstance(nous_cfg, dict):\n        return False  # Sparklebot: Nous guests are opt-in\n    return bool(nous_cfg.get("guest", False))'
  },
  // The app icon ships as sparklebot.ico. Windows caches shortcut icons by file path, and
  // resources\icon.ico is the path Hermes's own shortcut used, so a PC that had Hermes kept
  // showing the old picture. A new name forces Windows to read the Sparkle icon.
  { file: 'apps/desktop/electron-builder.config.cjs', from: "      to: 'icon.ico'", to: `      to: '${p.kebab}.ico'` },
  {
    file: 'apps/desktop/electron/app-icon.ts',
    from: "...(isWindows ? [path.join(resourcesPath ?? '', 'icon.ico'), path.join(appRoot, 'assets', 'icon.ico')] : []),",
    to: `...(isWindows ? [path.join(resourcesPath ?? '', '${p.kebab}.ico'), path.join(appRoot, 'assets', 'icon.ico')] : []),`
  },
  { file: 'scripts/install.ps1', from: "$iconIco = Join-Path $workDir 'resources\\icon.ico'", to: `$iconIco = Join-Path $workDir 'resources\\${p.kebab}.ico'` },
  // The installer's banner.
  {
    file: 'scripts/install.ps1',
    from: 'Write-Host "|             * Hermes Agent Installer                    |"',
    to: `Write-Host "|${(' '.repeat(17) + '* ' + p.display + ' Installer').padEnd(57)}|"`
  },
  {
    file: 'scripts/install.ps1',
    from: 'Write-Host "|  An open source AI agent by Nous Research.              |"',
    to: `Write-Host "|${'  by Sparkle Solutions, built on Hermes Agent (Nous).'.padEnd(57)}|"`
  },
  // Sparklebot is the desktop app: build it by default (-IncludeDesktop:$false still skips it).
  { file: 'scripts/install.ps1', from: '    [switch]$IncludeDesktop,', to: '    [switch]$IncludeDesktop = $true,' },
  { file: 'scripts/install.ps1', from: "$sc.Description = 'Hermes Agent'", to: `$sc.Description = '${p.display} (built on Hermes Agent)'` },
  {
    file: 'scripts/install.cmd',
    all: true,
    from: 'https://hermes-agent.nousresearch.com/install.ps1',
    to: `${brand.repository.replace('https://github.com/', 'https://raw.githubusercontent.com/')}/main/scripts/install.ps1`
  },
  {
    // `hermes desktop` (run by the installer and by updates) launches the built app by file name.
    file: 'hermes_cli/main_desktop.py',
    from: 'release_dir / d / "Hermes.exe" for d in ("win-unpacked", "win-ia32-unpacked", "win-arm64-unpacked")',
    to: `release_dir / d / "${p.display}.exe" for d in ("win-unpacked", "win-ia32-unpacked", "win-arm64-unpacked")`
  },
  // The warm Sparkle theme: its palette, its preset, first in the list and the default skin.
  {
    file: 'apps/shared/src/theme-presets.ts',
    from: "  ember: {\n    colors: {\n      background: '#160800',",
    to: themePaletteBlock + "  ember: {\n    colors: {\n      background: '#160800',"
  },
  { file: 'apps/desktop/src/themes/presets.ts', from: 'export const emberTheme: DesktopTheme = {', to: themePresetBlock + 'export const emberTheme: DesktopTheme = {' },
  {
    file: 'apps/desktop/src/themes/presets.ts',
    from: 'export const BUILTIN_THEMES: Record<string, DesktopTheme> = {\n  nous: nousTheme,',
    to: `export const BUILTIN_THEMES: Record<string, DesktopTheme> = {\n  ${theme.name}: ${theme.name}Theme,\n  nous: nousTheme,`
  },
  { file: 'apps/desktop/src/themes/presets.ts', from: "export const DEFAULT_SKIN_NAME = 'nous'", to: `export const DEFAULT_SKIN_NAME = '${theme.name}'` },
  { file: 'apps/desktop/src/themes/use-skin-command.ts', from: "  default: 'nous',", to: `  default: '${theme.name}',` },
  // Avatars: the Sparks as live-face shapes, warm identity colours, Spark as the main bot's look.
  ...avatarEdits(),
  // The big lettering on an empty chat, and two titles that name the product as "Hermes Agent".
  { file: 'apps/desktop/src/components/chat/intro.tsx', from: "const WORDMARK = 'HERMES AGENT'", to: `const WORDMARK = '${p.display.toUpperCase()}'` },
  { file: 'apps/desktop/src/i18n/en.ts', from: "settingUpTitle: 'Setting up Hermes Agent',", to: `settingUpTitle: 'Setting up ${p.display}',` },
  { file: 'apps/desktop/src/i18n/en_onboarding.ts', from: `headerTitle: "Let's get you setup with Hermes Agent",`, to: `headerTitle: "Let's get you set up with ${p.display}",` },
  {
    // The engine writes the first-run greeting itself, so it changes once a PC's engine runs this code.
    file: 'agent/onboarding_text.py',
    from: `GREETING = "Hi, I'm Hermes. Let's set things up for you. Then we'll get something cool done."`,
    to: `GREETING = "Hi, I'm ${p.display}. Let's set things up for you. Then we'll get something cool done."`
  },
  {
    file: 'agent/onboarding_text.py',
    from: "This is the user's first time opening the Hermes desktop app.",
    to: `This is the user's first time opening the ${p.display} desktop app.`
  },
  {
    // The footer links Nous's terms. They still apply to Nous services (web search runs through
    // Nous's tool gateway), so keep the links and say what Sparklebot is built on.
    file: 'apps/desktop/src/i18n/en_notices.ts',
    from: "      before: 'Use of Hermes Agent is subject to our ',",
    to: `      before: '${p.display} is built on Hermes Agent by Nous Research. Use of Nous services is subject to their ',`
  }
]

// English app texts: the word Hermes inside quoted text becomes the product name, except where
// it names Nous's own product or service. Lowercase `hermes` (the command, @hermes) is untouched.
const wordSwap = {
  dir: 'apps/desktop/src/i18n',
  match: /^en(_[a-z0-9_]+)?\.ts$/,
  word: /\bHermes\b(?!\s+(?:Cloud|Agent|catalog|plugin|Enterprise|Portal)\b)/g,
  // Screens that write visible text directly instead of through the translation files.
  extraFiles: [
    'apps/desktop/src/components/chat/intro.tsx',
    'apps/desktop/src/components/assistant-ui/thread/status.tsx',
    'apps/desktop/src/components/assistant-ui/thread/message-reactions.tsx',
    'apps/desktop/src/app/quick-entry/quick-entry-app.tsx',
    'apps/desktop/src/app/capabilities/scope-selector.tsx',
    'apps/desktop/src/app/pet-overlay/pet-overlay-app.tsx'
  ]
}
const stringLiteral = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g
function swapWords(text) {
  let swaps = 0
  const out = text.replace(stringLiteral, literal =>
    literal.replace(wordSwap.word, () => {
      swaps += 1
      return p.display
    }))
  return { out, swaps }
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1
}

// Pass 1: decide every edit before writing anything.
const files = new Map()
const report = []
let problems = 0
for (const edit of edits) {
  const full = path.join(root, edit.file)
  if (!files.has(full)) files.set(full, readFileSync(full, 'utf8').replace(/\r\n/g, '\n'))
  const text = files.get(full)
  const original = count(text, edit.from)
  const ours = count(text, edit.to)
  // When our text contains Hermes's text (an added line), the Hermes text stays visible
  // after applying; count it as done once our text is there exactly once.
  const containsFrom = edit.to.includes(edit.from)
  if (edit.all && original === 0 && ours >= 1) {
    report.push(['done', edit.file, `${edit.to.trim()} (x${ours})`])
  } else if (edit.all && original >= 1) {
    report.push(['to apply', edit.file, `${edit.to.trim()} (x${original})`])
    files.set(full, text.split(edit.from).join(edit.to))
  } else if (ours === 1 && original === (containsFrom ? 1 : 0)) {
    report.push(['done', edit.file, edit.to.trim().split('\n')[0]])
  } else if (ours === 0 && original === 1) {
    report.push(['to apply', edit.file, edit.to.trim().split('\n')[0]])
    files.set(full, text.replace(edit.from, edit.to))
  } else {
    problems += 1
    report.push(['PROBLEM', edit.file, `Hermes text found ${original} times, ours ${ours} times: ${edit.from.trim().split('\n')[0]}`])
  }
}

// English texts: swap the word in every en*.ts file, after the exact edits above.
let wordFiles = 0
let wordSwaps = 0
const wordTargets = [
  ...readdirSync(path.join(root, wordSwap.dir)).filter(n => wordSwap.match.test(n)).sort().map(n => path.join(wordSwap.dir, n)),
  ...wordSwap.extraFiles
]
for (const rel of wordTargets) {
  const full = path.join(root, rel)
  if (!existsSync(full)) {
    problems += 1
    report.push(['PROBLEM', rel, 'file gone; Hermes moved it'])
    continue
  }
  if (!files.has(full)) files.set(full, readFileSync(full, 'utf8').replace(/\r\n/g, '\n'))
  const { out, swaps } = swapWords(files.get(full))
  if (swaps) {
    wordFiles += 1
    wordSwaps += swaps
    files.set(full, out)
  }
}
if (wordFiles === 0 && !readdirSync(path.join(root, wordSwap.dir)).some(n => wordSwap.match.test(n))) {
  problems += 1
  report.push(['PROBLEM', wordSwap.dir, 'no English text files found; Hermes moved them'])
} else {
  report.push([wordSwaps ? 'to apply' : 'done', `${wordSwap.dir}/en*.ts`,
    wordSwaps ? `${wordSwaps} words "Hermes" -> "${p.display}" in ${wordFiles} files` : `no "Hermes" left outside the allowed names`])
}

// Icons: every file in brand/icons must exist in the checkout (a missing one means Hermes moved it).
const iconRoot = path.join(root, 'brand/icons')
const icons = []
;(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full)
    else icons.push(path.relative(iconRoot, full))
  }
})(iconRoot)
let iconsDone = 0
for (const rel of icons) {
  const target = path.join(root, rel)
  if (!existsSync(target)) {
    problems += 1
    report.push(['PROBLEM', rel.replaceAll('\\', '/'), 'Hermes no longer has this icon file'])
  } else if (readFileSync(target).equals(readFileSync(path.join(iconRoot, rel)))) {
    iconsDone += 1
  }
}
report.push([iconsDone === icons.length ? 'done' : 'to apply', 'icons', `${iconsDone} of ${icons.length} Sparkle icon files in place`])

// The public front page: Sparklebot's README; Hermes's own README is kept beside it.
const readme = path.join(root, 'README.md')
const hermesReadme = path.join(root, 'README.hermes-agent.md')
const publicReadme = path.join(root, 'brand/README.public.md')
const readmeDone = readFileSync(readme, 'utf8') === readFileSync(publicReadme, 'utf8')
if (!readmeDone && !existsSync(hermesReadme) && !/Hermes Agent/.test(readFileSync(readme, 'utf8'))) {
  problems += 1
  report.push(['PROBLEM', 'README.md', "neither Hermes's README nor ours; check by hand"])
} else {
  report.push([readmeDone ? 'done' : 'to apply', 'README.md', 'Sparklebot front page (Hermes README kept as README.hermes-agent.md)'])
}

for (const [state, file, what] of report) console.log(`${state.padEnd(8)} ${file}  ${what}`)

if (problems) {
  console.error(`\nStopped: ${problems} problem(s). Nothing was written. Hermes changed a place the overlay edits; update brand/apply.mjs.`)
  process.exit(1)
}
const pending = report.some(([state]) => state === 'to apply')
if (checkOnly) {
  console.log(pending ? '\nNot fully branded yet.' : '\nFully branded.')
  process.exit(pending ? 1 : 0)
}

// Pass 2: write. Keep each file's own line endings.
if (!checkOnly && !readmeDone) {
  if (!existsSync(hermesReadme)) cpSync(readme, hermesReadme)
  cpSync(publicReadme, readme)
}
for (const [full, text] of files) {
  const before = readFileSync(full, 'utf8')
  const out = before.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text
  if (out !== before) writeFileSync(full, out)
}
for (const rel of icons) cpSync(path.join(iconRoot, rel), path.join(root, rel))
console.log(pending ? '\nApplied. Run with --check to confirm.' : '\nAlready fully branded. Nothing changed.')
