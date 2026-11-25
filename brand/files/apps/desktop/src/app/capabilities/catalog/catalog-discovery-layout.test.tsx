// Sparklebot: the Capabilities page froze ~2.6 s on every open (a full filter per category and
// re-ranking inside the sort comparator). These tests pin the replacement, discoveryLayout, to
// upstream's result on large catalogs and keep its work linear in the entries.
import { featuredPicks, groupCatalogPlugins, isOfficialSkillSource, PLUGIN_CATEGORIES } from '@hermes/shared'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { BENTO_COLUMNS, packBento } from './catalog-bento'
import { pluginTier } from './catalog-curation'
import type { CatalogEntry, CatalogKind } from './catalog-data'
import { CatalogDiscovery, discoveryLayout } from './catalog-discovery'
import { catalogCategories } from './catalog-query'
import type * as CatalogQuery from './catalog-query'

// Counts the layout passes; still the real function.
vi.mock('./catalog-query', async importOriginal => {
  const actual = await importOriginal<typeof CatalogQuery>()

  return { ...actual, catalogCategories: vi.fn(actual.catalogCategories) }
})

// The weekly hero rotation reads the clock; pin it so both derivations see the same week.
const NOW = Date.parse('2026-11-25T12:00:00Z')

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterAll(() => vi.useRealTimers())

type Layout = ReturnType<typeof discoveryLayout>

/** Upstream's derivation (Hermes Agent v0.23.2, catalog-discovery.tsx), verbatim apart from the
 *  i18n tier titles: the oracle every result below must match. */
function legacyLayout(entries: CatalogEntry[], kind: CatalogKind, narrowed?: boolean, byCategory?: boolean): Layout {
  const MIN_SHELF = 3
  const PLUGIN_TIERS = ['official', 'verified'] as const
  const topStars = (items: CatalogEntry[]) => Math.max(-1, ...items.map(entry => entry.stars ?? -1))

  const featured = narrowed ? [] : featuredPicks(entries, entry => ({
    featured: entry.featured,
    official: kind === 'plugins' ? pluginTier(entry) === 'official' : isOfficialSkillSource(entry.source),
    pictured: Boolean(entry.imageUrl),
    addedAt: entry.addedAt,
    stars: entry.stars
  }))

  const others = entries.filter(entry => !featured.includes(entry))
  const tiered = kind === 'plugins' && !byCategory ? PLUGIN_TIERS.map(tier => ({ tier, items: others.filter(entry => pluginTier(entry) === tier) })).filter(({ items }) => items.length) : []
  const remaining = kind === 'plugins' && !byCategory ? others.filter(entry => pluginTier(entry) === 'community') : others

  const sections: [string, string, CatalogEntry[]][] = (
    kind === 'plugins'
      ? groupCatalogPlugins(remaining).map(([key, items]) => [key, PLUGIN_CATEGORIES[key].label, items] as [string, string, CatalogEntry[]])
      : catalogCategories(remaining).map(([key, meta]) => [key, meta.label, remaining.filter(entry => entry.category === key)] as [string, string, CatalogEntry[]])
  ).sort((a, b) => topStars(b[2]) - topStars(a[2]))

  const minShelf = byCategory ? 1 : MIN_SHELF
  const shelves = sections.filter(([, , items]) => items.length >= minShelf)
  const loose = sections.filter(([, , items]) => items.length < minShelf).flatMap(([, , items]) => items)

  return { featured, tiered, shelves, loose }
}

/** Seeded PRNG (mulberry32): every run builds the same catalogs. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const NAMES = ['alpha', 'beta', 'gamma', 'delta', 'atlas', 'Zephyr', 'émile', 'Ångström', 'notes', 'research', 'a11y', 'item 2', 'item 10']
const SKILL_SOURCES = ['official', 'built-in', 'optional', 'clawhub', 'github', 'community']
const PLUGIN_SOURCES = ['official', 'bundled', 'verified', 'community', 'community', 'user', 'git']
const PLUGIN_KEYS = [...Object.keys(PLUGIN_CATEGORIES), 'gaming', 'uncategorized', '']

/** A feed-shaped catalog: skewed category sizes (a few large, a long tail of 1-2 entry ones),
 *  repeated names, star ties across shelves, curated ranks, artwork and recent additions. Edge
 *  categories: an `other` key, an "other" label, two keys sharing a label, a key whose label
 *  changes between entries (the last one wins in the facet). */
function catalog(kind: CatalogKind, size: number, categories: number, seed: number): CatalogEntry[] {
  const next = random(seed)
  const pick = <T,>(values: readonly T[]) => values[Math.floor(next() * values.length)]

  const skillCategory = (): [string, string] => {
    const index = Math.floor(categories * next() ** 2.5)

    if (index === 1) {return ['other', 'Other']}

    if (index === 2) {return ['misc', 'other']}

    if (index === 3 || index === 4) {return [`dup-${index}`, 'Data & Analytics']}

    if (index === 5) {return ['research', next() < 0.5 ? 'Research' : 'Research & Analysis']}

    return [`cat-${index}`, `Category ${String.fromCharCode(65 + (index % 26))}${index}`]
  }

  return Array.from({ length: size }, (_, index) => {
    const [category, categoryLabel] = kind === 'plugins' ? [pick(PLUGIN_KEYS), ''] : skillCategory()
    const name = `${pick(NAMES)}${next() < 0.4 ? '' : ` ${Math.floor(next() * 50)}`}`

    return {
      id: `${kind}:${index}`,
      name,
      source: pick(kind === 'plugins' ? PLUGIN_SOURCES : SKILL_SOURCES),
      category,
      categoryLabel: categoryLabel || category,
      tags: [],
      search: name.toLowerCase(),
      stars: next() < 0.35 ? null : Math.floor(next() * 40),
      imageUrl: next() < 0.2 ? 'https://raw.githubusercontent.com/example/art/main/card.png' : null,
      featured: next() < 0.01 ? 1 + Math.floor(next() * 6) : undefined,
      addedAt: next() < 0.3 ? new Date(NOW - Math.floor(next() * 60) * 86_400_000).toISOString() : undefined
    } as unknown as CatalogEntry
  })
}

const ids = (items: CatalogEntry[]) => items.map(item => item.id)

/** The layout as plain data: which shelves, which cards, in which order. */
const shape = (layout: Layout) => ({
  featured: ids(layout.featured),
  tiered: layout.tiered.map(({ items, tier }) => ({ tier, ids: ids(items) })),
  shelves: layout.shelves.map(([key, label, items]) => ({ key, label, ids: ids(items) })),
  loose: ids(layout.loose)
})

const FLAGS = [
  { narrowed: false, byCategory: false },
  { narrowed: true, byCategory: false },
  { narrowed: true, byCategory: true },
  { narrowed: false, byCategory: true }
]

const SIZES = [
  { size: 0, categories: 1, seed: 1 },
  { size: 2, categories: 3, seed: 2 },
  { size: 25, categories: 12, seed: 3 },
  { size: 340, categories: 90, seed: 4 },
  { size: 650, categories: 160, seed: 5 },
  { size: 2000, categories: 400, seed: 6 }
]

describe('discovery layout matches upstream', () => {
  it.each((['skills', 'plugins'] as const).flatMap(kind => SIZES.flatMap(size => FLAGS.map(flags => ({ kind, ...size, ...flags })))))(
    '$kind: $size entries, $categories categories, narrowed $narrowed, byCategory $byCategory',
    ({ byCategory, categories, kind, narrowed, seed, size }) => {
      const entries = catalog(kind, size, categories, seed)

      expect(shape(discoveryLayout(entries, kind, narrowed, byCategory))).toEqual(shape(legacyLayout(entries, kind, narrowed, byCategory)))
    }
  )

  it('exercises what decides the order: many shelves, star ties between them, every entry placed once', () => {
    const entries = catalog('skills', 650, 160, 5)
    const layout = discoveryLayout(entries, 'skills')
    const ranks = layout.shelves.map(([, , items]) => Math.max(-1, ...items.map(entry => entry.stars ?? -1)))
    const placed = [...layout.featured, ...layout.shelves.flatMap(([, , items]) => items), ...layout.loose]

    expect(layout.shelves.length).toBeGreaterThan(20)
    expect(new Set(ranks).size).toBeLessThan(ranks.length)
    expect(layout.loose.length).toBeGreaterThan(0)
    expect(layout.featured.length).toBeGreaterThan(1)
    expect(new Set(ids(placed))).toEqual(new Set(ids(entries)))
    expect(placed).toHaveLength(entries.length)
  })
})

/** What the page renders, minus the developer banner: section ids and card ids in DOM order. */
const page = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-catalog-section]')]
    .filter(node => node.getAttribute('data-catalog-section') !== 'developer')
    .map(node => ({ id: node.getAttribute('data-catalog-section'), cards: [...node.querySelectorAll('[data-id]')].map(card => card.getAttribute('data-id')) }))

/** The same page built from upstream's layout with the component's paging (8 shelves, 3 loose rows). */
function expectedPage(layout: Layout) {
  const tiles = (items: CatalogEntry[], rows?: number, flip = false) => packBento(items, BENTO_COLUMNS, rows, flip).map(tile => tile.entry.id)

  return [
    ...(layout.featured.length ? [{ id: 'featured', cards: ids(layout.featured) }] : []),
    ...layout.tiered.map(({ items, tier }, index) => ({ id: tier, cards: tiles(items, Math.ceil(items.length / BENTO_COLUMNS) + 1, index % 2 === 1) })),
    ...layout.shelves.slice(0, 8).map(([key, , items], index) => ({ id: key, cards: tiles(items, undefined, index % 2 === 1) })),
    ...(layout.loose.length && layout.shelves.length <= 8 ? [{ id: 'more', cards: tiles(layout.loose, 3) }] : [])
  ]
}

// A fresh card renderer and handler each time, as the parent page passes them.
const discovery = (entries: CatalogEntry[], kind: CatalogKind, narrowed = false, byCategory = false) => (
  <CatalogDiscovery
    byCategory={byCategory}
    card={item => <article data-id={item.id} key={item.id}>{item.name}</article>}
    entries={entries}
    kind={kind}
    narrowed={narrowed}
    onCategory={() => {}}
  />
)

describe('discovery page', () => {
  it.each([
    { kind: 'skills' as const, size: 650, categories: 160, seed: 5, narrowed: false, byCategory: false, shows: ['featured'] },
    { kind: 'skills' as const, size: 60, categories: 25, seed: 7, narrowed: false, byCategory: false, shows: ['more'] },
    { kind: 'skills' as const, size: 340, categories: 90, seed: 4, narrowed: true, byCategory: true, shows: ['cat-0'] },
    { kind: 'plugins' as const, size: 400, categories: 0, seed: 8, narrowed: false, byCategory: false, shows: ['featured', 'official', 'verified', 'general'] },
    { kind: 'plugins' as const, size: 400, categories: 0, seed: 9, narrowed: true, byCategory: true, shows: ['general', 'tools'] }
  ])('renders the same sections and cards as upstream: $kind, $size entries, byCategory $byCategory', ({ byCategory, categories, kind, narrowed, seed, shows, size }) => {
    const entries = catalog(kind, size, categories, seed)
    const { container } = render(discovery(entries, kind, narrowed, byCategory))

    expect(page(container)).toEqual(expectedPage(legacyLayout(entries, kind, narrowed, byCategory)))
    expect(page(container).map(section => section.id)).toEqual(expect.arrayContaining(shows))
  })

  it('derives the layout once per input, not again on "Show more" or a same-props render', () => {
    const entries = catalog('skills', 650, 160, 5)
    const passes = vi.mocked(catalogCategories)
    passes.mockClear()

    const view = render(discovery(entries, 'skills'))
    const before = page(view.container).length
    expect(passes).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(page(view.container).length).toBeGreaterThan(before)
    expect(passes).toHaveBeenCalledTimes(1)

    view.rerender(discovery(entries, 'skills'))
    expect(passes).toHaveBeenCalledTimes(1)

    // New entries (a refetch, a filter change) are a new input.
    view.rerender(discovery([...entries], 'skills'))
    expect(passes).toHaveBeenCalledTimes(2)
  })
})

/** The same entries with every read of `field` counted: a measure of work that does not
 *  depend on how fast or busy the machine is (wall-clock bounds failed under load). */
function counting(entries: CatalogEntry[], field: 'category' | 'stars') {
  const reads = { count: 0 }

  const copies = entries.map(entry => {
    const value = entry[field]

    return Object.defineProperty({ ...entry }, field, {
      enumerable: true,
      get: () => {
        reads.count += 1

        return value
      }
    })
  })

  return { entries: copies, reads }
}

describe('discovery layout work', () => {
  it('reads each entry a few times, however many categories there are', () => {
    // Upstream filtered every entry once per category: ~2,000 reads per entry here.
    const { entries, reads } = counting(catalog('skills', 20_000, 2_000, 12), 'category')
    discoveryLayout(entries, 'skills')

    expect(reads.count).toBeLessThanOrEqual(5 * entries.length)
  })

  it('ranks each shelf once, not again in every comparison of the sort', () => {
    const { entries, reads } = counting(catalog('skills', 20_000, 2_000, 12), 'stars')
    discoveryLayout(entries, 'skills')

    // Once for the hero pick, once for the shelf's rank.
    expect(reads.count).toBeLessThanOrEqual(3 * entries.length)
  })

  it('ranks a shelf larger than the spread-argument limit', () => {
    // Upstream's Math.max(-1, ...stars) threw RangeError past ~120k entries in one shelf (~500k
    // on a worker thread's larger stack). One entry repeated keeps a million-entry shelf cheap.
    const [entry] = catalog('skills', 1, 1, 13)
    const entries = Array.from({ length: 1_000_000 }, () => entry)

    const layout = discoveryLayout(entries, 'skills', true)

    expect(layout.shelves.map(([key, , items]) => [key, items.length])).toEqual([[entry.category, 1_000_000]])
  })
})
