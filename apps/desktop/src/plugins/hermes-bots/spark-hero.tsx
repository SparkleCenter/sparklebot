// Sparklebot: the main bot (Spark) shown large at the top of the Bots list, with its team listed
// below. Copied in by brand/apply.mjs. Clicking it opens the main bot's chat, as its row did.

import { host, useValue } from '@hermes/plugin-sdk'

import { avatarColor, botAppearance, BotFace } from './avatar'
import { isBackfilledFacePng } from './avatar-image'
import { $botMeta, $lastRoster, isDefaultBot } from './data'
import { displayName, stripPreviewMarkdown } from './labels'
import { openRosterBot } from './roster-actions'
import { botRosterMeta } from './routing'
import { A2A_PREFIX_RE, previewKind } from './row-helpers'
import type { RosterRow } from './types'

/** The main bot on the connection in use (several connections can each have one). */
export function primaryRosterBot(roster: readonly RosterRow[]): RosterRow | undefined {
  const activeConnectionId = String(host.state.connectionId?.get?.() || 'local').trim()
  const primaries = roster.filter(bot => isDefaultBot(bot))

  return primaries.find(bot => (bot.connectionId || 'local') === activeConnectionId) || primaries[0]
}

export function SparkHero({ bot }: { bot: RosterRow | undefined }) {
  const allMeta = useValue($botMeta)

  if (!bot) {
    return null
  }

  const meta = botRosterMeta(bot, allMeta)
  const name = displayName(bot, meta)
  const { color, image, shape } = botAppearance(bot.name, meta)
  const photo = Boolean(image && !isBackfilledFacePng(image))
  const session = bot.canonical_session || bot.last_session
  const { fromBot } = previewKind(session?.preview, $lastRoster.get(), bot.connectionId)

  const preview = stripPreviewMarkdown(
    fromBot ? (session?.preview || '').replace(A2A_PREFIX_RE, '').trim() : session?.preview || ''
  )

  return (
    <button
      aria-label={name}
      className="mx-1.5 mb-1 mt-2 flex shrink-0 flex-col items-center gap-1 rounded-xl px-3 pb-3 pt-2 text-center transition-colors hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring"
      data-slot="sparklebot-hero"
      onClick={() => void openRosterBot(bot, { intent: 'in-place' })}
      type="button"
    >
      <BotFace
        color={avatarColor(color, bot.name)}
        image={photo ? image : null}
        mood="idle"
        name={bot.name}
        shape={shape}
        size={76}
      />
      <span className="text-sm font-semibold text-foreground">{name}</span>
      {preview ? <span className="line-clamp-2 w-full text-xs text-muted-foreground">{preview}</span> : null}
    </button>
  )
}
