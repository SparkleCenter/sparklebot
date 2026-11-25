// Sparklebot: a routine's delivery in the bots list reads as the routine's name, not the engine's header.
// The header is built in cron/scheduler_delivery.py (bot_chat_message); the roster preview is its first 80
// characters plus "..." (tui_gateway/methods_profiles.py _latest_message_preview).
import { describe, expect, it } from 'vitest'

import { stripPreviewMarkdown } from './labels'

const header = (name: string) =>
  `[Cronjob "${name}" output — scheduled job, not the user. Review it, act on anything that needs action, and summarize for the chat.]`

// What the roster sends: whitespace collapsed, cut to 80 characters plus "...".
const rosterPreview = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > 80 ? `${flat.slice(0, 80)}...` : flat
}

describe('stripPreviewMarkdown and routine deliveries', () => {
  it('shows the routine name for the 80-character roster preview', () => {
    const text = `${header('Market and tender radar')}\n\n## Today\nThree new tenders.`

    expect(stripPreviewMarkdown(rosterPreview(text))).toBe('Market and tender radar')
  })

  it('shows the name and the first words when the whole message arrives', () => {
    const text = `${header('Market and tender radar')}\n\n## Today\nThree new tenders.`

    expect(stripPreviewMarkdown(text)).toBe('Market and tender radar: Today Three new tenders.')
  })

  it('keeps quotes inside a routine name', () => {
    const text = `${header('Weekly "EFUG" digest')}\n\nAll quiet.`

    expect(stripPreviewMarkdown(rosterPreview(text))).toBe('Weekly "EFUG" digest')
    expect(stripPreviewMarkdown(text)).toBe('Weekly "EFUG" digest: All quiet.')
  })

  it('leaves ordinary messages alone, also ones that mention a cronjob', () => {
    expect(stripPreviewMarkdown('Can you check the [Cronjob "x" output — later]?')).toBe(
      'Can you check the [Cronjob "x" output — later]?'
    )
    expect(stripPreviewMarkdown('**Done**: sent the brief')).toBe('Done: sent the brief')
  })
})
