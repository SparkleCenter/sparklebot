// Sparklebot: start the app when the user signs in to Windows (or macOS). On by default; the
// switch in Settings → Appearance → Window & layout turns it off. Copied in by brand/apply.mjs.
//
// Uses the operating system's own login-item list (on Windows the per-user Run key), pointing at
// this executable. Unpackaged development runs are left alone.

import fs from 'node:fs'
import path from 'node:path'

import { app, BrowserWindow, ipcMain } from 'electron'

export interface StartAtLoginStatus {
  enabled: boolean
  available: boolean
}

interface Options {
  preferencesPath: string
  log: (message: string) => void
}

export function createStartAtLogin(options: Options) {
  const available = (process.platform === 'win32' || process.platform === 'darwin') && app.isPackaged
  let enabled = true

  const status = (): StartAtLoginStatus => ({ enabled, available })

  const broadcast = () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('hermes:start-at-login:changed', status())
      }
    }
  }

  const apply = () => {
    if (!available) {
      return
    }

    try {
      app.setLoginItemSettings({ openAtLogin: enabled })
    } catch (error) {
      options.log(`[start-at-login] could not update the login item: ${error}`)
    }
  }

  function start() {
    try {
      // Missing or unreadable preference: the Sparklebot default, on.
      enabled = JSON.parse(fs.readFileSync(options.preferencesPath, 'utf8')).enabled !== false
    } catch {
      enabled = true
    }

    apply()
  }

  function setEnabled(on: boolean): StartAtLoginStatus {
    enabled = on === true
    fs.mkdirSync(path.dirname(options.preferencesPath), { recursive: true })
    fs.writeFileSync(`${options.preferencesPath}.tmp`, JSON.stringify({ enabled }), 'utf8')
    fs.renameSync(`${options.preferencesPath}.tmp`, options.preferencesPath)
    apply()
    broadcast()

    return status()
  }

  ipcMain.handle('hermes:start-at-login:get', status)
  ipcMain.handle('hermes:start-at-login:set', (_event, on) => setEnabled(on === true))

  return { start, status }
}
