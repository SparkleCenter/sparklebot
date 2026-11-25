// Sparklebot: the "Start with Windows" switch (Settings → Appearance → Window & layout).
// Copied in by brand/apply.mjs; the native side is electron/start-at-login.ts.

import { useEffect, useState } from 'react'

import { notifyError } from '@/store/notifications'

import { ToggleRow } from './primitives'

type Status = { enabled: boolean; available: boolean }

type Bridge = {
  get: () => Promise<Status>
  set: (on: boolean) => Promise<Status>
  onChanged: (callback: (status: Status) => void) => () => void
}

export function StartAtLoginSetting() {
  const bridge = (window as unknown as { hermesDesktop?: { startAtLogin?: Bridge } }).hermesDesktop?.startAtLogin
  const [status, setStatus] = useState<Status | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!bridge) {
      return
    }

    const unsubscribe = bridge.onChanged(next => setStatus(next))

    bridge
      .get()
      .then(setStatus)
      .catch(error => notifyError(error, 'Could not read the start-with-Windows setting'))

    return unsubscribe
  }, [bridge])

  if (!bridge || (status && !status.available)) {
    return null
  }

  const save = async (enabled: boolean) => {
    const previous = status
    setSaving(true)
    setStatus({ enabled, available: status?.available ?? true })

    try {
      setStatus(await bridge.set(enabled))
    } catch (error) {
      setStatus(previous)
      notifyError(error, 'Could not save the start-with-Windows setting')
    } finally {
      setSaving(false)
    }
  }

  return (
    <ToggleRow
      checked={status?.enabled ?? true}
      description="Opens Sparklebot when you sign in to your computer. Your bots and routines keep running either way."
      disabled={!status || saving}
      label="Start Sparklebot with Windows"
      onChange={enabled => void save(enabled)}
    />
  )
}
