// Deterministic per-profile color so a profile is glanceable across the app
// (the sidebar profile rail). The default/root profile has no color — named
// profiles get a stable hue derived from the name, so the same profile always
// reads the same color without persisting anything.

const PROFILE_TAG_SATURATION = 68
const PROFILE_TAG_LIGHTNESS = 58
/** Sparklebot's warm identity palette (brand/theme.json avatarColors). */
const SPARKLE_WARM: readonly string[] = ["#F39200","#F2B33D","#FFC93C","#F07258","#D9542B","#C08A5B","#8B5E3C","#E8C8A4","#8FB38A","#5E9C8C","#A0607A","#F4A6A0"]

function hashString(value: string): number {
  let hash = 0

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }

  return hash
}

// Returns an hsl() string for a named profile, or null for default/empty
// (rendered neutral / untagged).
export function profileColor(name: null | string | undefined): null | string {
  const key = (name ?? '').trim()

  if (!key || key === 'default') {
    return null
  }

  return SPARKLE_WARM[hashString(key) % SPARKLE_WARM.length]
}

// A profile's effective color: a user-picked override wins, else the
// deterministic hue. Default/empty stays neutral (null) regardless.
export function resolveProfileColor(name: null | string | undefined, overrides: Record<string, string>): null | string {
  const key = (name ?? '').trim()

  if (!key || key === 'default') {
    return null
  }

  return overrides[key] ?? profileColor(key)
}

// Curated swatches for the rail color picker — evenly spaced hues at the same
// saturation/lightness as the deterministic palette, so picks stay cohesive.
export const PROFILE_SWATCHES: readonly string[] = SPARKLE_WARM

// Translucent fill derived from a profile color, for tag backgrounds.
export function profileColorSoft(color: string, percent = 16): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`
}
