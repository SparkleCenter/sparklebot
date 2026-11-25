// Sparklebot speed fixes (25.11.2026). Each edit was designed against Hermes v0.23.2 and checked by a
// second reviewer (anchor unique, applies once, a re-run reports it done, its test fails without it).
// They change speed only, not behaviour; each also suits a patch to Nous so the nightly updates carry it.
// Same {file, from, to} rules as the list in brand/apply.mjs, which imports this one.

export default [
  // 1. Bot switch: keep each bot's banner inventory (tool snapshot, toolset availability, skills scan)
//    for 30 s instead of rebuilding it on every switch, and spawn no git for a folder that cannot be a
//    repo. Measured 25.11.2026: ~1.8 s of a ~2.2 s switch.
//    Test: tests/gateway/test_sparklebot_inventory_cache.py
  // Adds the inventory cache next to session_inventory and moves no upstream symbol. It holds the shared key
  // (off where model_tools keeps its own memo off: no profile identity or a hosted tenant; HERMES_SESSION_ID
  // left out of the env part), the skills signature, the single-flight TTL cache with deep copies, the tools
  // helper, and a skills builder that rescans the catalog on a cache miss, so an in-place SKILL.md edit really
  // shows on the next request. The TTL is 30 s, the same as the check_fn verdicts and the skills catalog under
  // it, so probe-only state is never more than about 60 s old.
  {
    file: 'gateway/session_local_inventory.py',
    from: String.raw`def session_inventory(authority, policy, agent, cwd):`,
    to: String.raw`# Sparklebot: a bot switch (session.resume) rebuilt this whole inventory, and its tool snapshot, toolset
# availability probes and skills scan were most of its ~1.8 s (measured 25.11.2026). The inventory is display
# only (banner, status bar, a lazy session tool count): the agent builds its own tool list on its first turn,
# so a cached copy never changes what the agent can do. Each cached section is keyed by everything it reads
# that a stat or a counter can show (profile, the resolved session config, config.yaml, .env and auth.json,
# the process env, the tool registry generation, the check_fn cache epoch, every skill dir and SKILL.md), so
# the first request after such a change rebuilds it. What only a probe sees (a daemon, a binary on PATH, the
# environments or apps a skill needs) shows within _SB_INVENTORY_TTL_S plus the 30 s the check_fn verdicts
# under it keep. Git branch, project, MCP status, provider, version and update notice stay uncached.
import copy
import hashlib
import json
import os
import threading
import time

_SB_INVENTORY_TTL_S = 30.0  # the same 30 s the check_fn verdicts and the skills catalog under it keep
_SB_INVENTORY_MAX = 64
_SB_VOLATILE_ENV = frozenset({"HERMES_SESSION_ID"})  # rewritten by every agent build; no section reads it
_sb_inventory: dict = {}  # key -> (time.monotonic() when its build started, value)
_sb_inventory_gates: dict = {}  # key -> the lock its one in-flight build holds
_sb_inventory_lock = threading.Lock()


def _sb_stat(path):
    try:
        st = os.stat(path)
    except (OSError, TypeError, ValueError):
        return None
    return st.st_mtime_ns, st.st_size


def _sb_inventory_key(config):
    """The key part every cached section shares, read inside the owner profile scope; None: no caching."""
    try:
        import model_tools  # noqa: F401 -- its first import registers the tools: read the generation after it
        from hermes_cli.config import get_config_path
        from hermes_constants import get_default_hermes_root, get_hermes_home
        from tools.environments.sandbox_scope import hosted_scope
        from tools.registry import CHECK_FN_CACHE_BYPASS, check_fn_cache_epoch, check_fn_cache_scope, registry
        scope = check_fn_cache_scope()
        if scope == CHECK_FN_CACHE_BYPASS or hosted_scope() is not None:
            return None  # no profile identity, or a hosted tenant: the model_tools memo stays off there too
        try:
            text = json.dumps(config, sort_keys=True, default=repr)
        except (TypeError, ValueError):
            text = repr(config)
        home, root = get_hermes_home(), get_default_hermes_root()
        files = (get_config_path(), home / ".env", home / "auth.json", root / ".env", root / "auth.json")
        env = frozenset(item for item in os.environ.items() if item[0] not in _SB_VOLATILE_ENV)
        return (registry.current_scope_key(), str(home), scope,
                hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest(),
                tuple(_sb_stat(path) for path in files), hash(env),
                registry._generation, check_fn_cache_epoch())
    except Exception:  # health: allow BLE001 -- no key: the inventory is built uncached, as before
        logger.debug("session inventory cache key unavailable", exc_info=True)
        return None


def _sb_skills_sig():
    """The skills catalog change signature (agent.skill_commands._skill_dirs_signature: each skill dir with
    its mtime and child dirs, the disabled set, the platform) plus the mtime and size of each SKILL.md, so an
    in-place edit shows too; None: no caching."""
    try:
        from agent.skill_commands import _skill_dirs_signature
        sig = _skill_dirs_signature()
        if sig is None:
            return None
        return sig, tuple(_sb_stat(os.path.join(entry[0], "SKILL.md")) for entry in sig[0])
    except Exception:  # health: allow BLE001 -- no signature: skills are scanned uncached, as before
        logger.debug("skills signature unavailable", exc_info=True)
        return None


def _sb_key(*parts):
    """A cache key from *parts*, or None (build uncached) when a part is unknown or unhashable."""
    if any(part is None for part in parts):
        return None
    try:
        hash(parts)
    except TypeError:
        return None
    return parts


def _sb_cached(key, build, *, keep=None):
    """build(), reused for _SB_INVENTORY_TTL_S under *key* (None: always built). Threads asking for one key
    meanwhile wait for its one build. A build that raises, or that *keep* rejects, is not stored. Callers get
    deep copies, so nothing they change reaches the cache."""
    if key is None:
        return build()
    with _sb_inventory_lock:
        hit = _sb_inventory.get(key)
        if hit is not None and time.monotonic() - hit[0] < _SB_INVENTORY_TTL_S:
            return copy.deepcopy(hit[1])
        gate = _sb_inventory_gates.setdefault(key, threading.Lock())
    with gate:
        try:
            with _sb_inventory_lock:
                hit = _sb_inventory.get(key)
                if hit is not None and time.monotonic() - hit[0] < _SB_INVENTORY_TTL_S:
                    return copy.deepcopy(hit[1])
            started = time.monotonic()
            value = build()
            if keep is None or keep(value):
                stored = copy.deepcopy(value)
                with _sb_inventory_lock:
                    now = time.monotonic()
                    for old in [k for k, (at, _v) in _sb_inventory.items() if now - at >= _SB_INVENTORY_TTL_S]:
                        del _sb_inventory[old]
                    _sb_inventory.pop(key, None)
                    while len(_sb_inventory) >= _SB_INVENTORY_MAX:
                        del _sb_inventory[next(iter(_sb_inventory))]
                    _sb_inventory[key] = (started, stored)
            return value
        finally:
            with _sb_inventory_lock:
                if _sb_inventory_gates.get(key) is gate:
                    del _sb_inventory_gates[key]


def _sb_policy_tool_names(policy, config):
    """_policy_tools as the inventory keeps it: (enabled toolsets, tool names by toolset)."""
    enabled, tools = _policy_tools(policy, config)
    return enabled, _grouped(tools)


def _sb_banner_skills(fresh):
    """hermes_cli.banner.get_available_skills, the non-CLI skills builder. Under a routed profile banner keeps
    no memo and reads the tools.skills_tool catalog cache, whose own 30 s TTL is all that shows an in-place
    SKILL.md edit. A *fresh* build (the inventory cache missed: a skill dir or SKILL.md changed, or the entry
    expired) drops that one catalog entry first, as _cli_skills does, so the scan reads the files and stores a
    new entry. Uncached (*fresh* False) it is the plain call, as before, and so is a fresh build if Hermes ever
    moves that cache or the home override (found by the final review of 25.11.2026)."""
    from hermes_cli.banner import get_available_skills
    if fresh:
        try:
            from hermes_constants import get_hermes_home_override
            from tools import skills_tool
            if get_hermes_home_override() is not None:
                skills_tool._SKILLS_CACHE.pop(("filtered", False), None)
        except Exception:  # health: allow BLE001 -- Hermes moved one of these: the plain call, as before
            logger.debug("skills catalog entry not dropped", exc_info=True)
    return get_available_skills()


def session_inventory(authority, policy, agent, cwd):`
  },
  // Computes the shared key once per call, inside owner_scope, so it reads the owning profile's home, files and
  // check_fn scope.
  {
    file: 'gateway/session_local_inventory.py',
    from: String.raw`        config = policy.config(authority, secrets=False) if policy is not None else {}`,
    to: String.raw`        config = policy.config(authority, secrets=False) if policy is not None else {}
        sb_key = _sb_inventory_key(config)  # Sparklebot: shared part of the inventory cache keys`
  },
  // Reuses the lazy session's tool snapshot (about 236 ms mean in pytimers.log) per frozen policy, a hashable
  // frozen dataclass. It stays inside the original try/except, so a failing build still shows no tools, logs
  // the same warning and is not stored.
  {
    file: 'gateway/session_local_inventory.py',
    from: String.raw`                    enabled, tools = _policy_tools(policy, config)
                    info["tools"] = _grouped(tools)`,
    to: String.raw`                    # Sparklebot: cached per policy (_sb_cached).
                    enabled, info["tools"] = _sb_cached(
                        _sb_key(sb_key, "tools", policy), lambda: _sb_policy_tool_names(policy, config))`
  },
  // Reuses toolset availability (478 ms mean; check_tool_availability is uncached upstream and costs about 210
  // ms even with warm verdicts) per profile and enabled set. It stays inside the original suppress.
  {
    file: 'gateway/session_local_inventory.py',
    from: String.raw`            info["tool_availability"] = compute_toolset_availability(enabled)`,
    to: String.raw`            # Sparklebot: cached per enabled toolset set (_sb_cached).
            info["tool_availability"] = _sb_cached(
                _sb_key(sb_key, "availability", tuple(sorted(map(str, enabled)))),
                lambda: compute_toolset_availability(enabled))`
  },
  // Reuses skills (406 ms mean) per profile, surface and skills signature. On a miss the non-CLI builder
  // rescans the catalog (see _sb_banner_skills). With no key it is the plain upstream call. It stays inside the
  // original suppress.
  {
    file: 'gateway/session_local_inventory.py',
    from: String.raw`        with contextlib.suppress(Exception):
            if policy is not None and policy.source == "cli":
                info["skills"] = _cli_skills()
            else:
                from hermes_cli.banner import get_available_skills
                info["skills"] = get_available_skills()`,
    to: String.raw`        with contextlib.suppress(Exception):
            # Sparklebot: the two skill builders, cached per skills signature (_sb_cached); an empty
            # result (a failed scan reads the same) is not kept.
            cli_surface = policy is not None and policy.source == "cli"
            skills_key = _sb_key(sb_key, "skills", cli_surface, _sb_skills_sig())
            info["skills"] = _sb_cached(
                skills_key, _cli_skills if cli_surface else lambda: _sb_banner_skills(skills_key is not None),
                keep=bool)`
  },
  // Spawns no git for a cwd with no repo marker on its literal path or on its resolved path. The proposal
  // walked only the literal path, so a symlinked or junctioned cwd inside a checkout lost its branch on every
  // call. branch(home) now costs 0.25 ms instead of about 155-310 ms.
  {
    file: 'tui_gateway/git_probe.py',
    from: String.raw`def branch(cwd: str) -> str:
    return run_git(cwd, "branch", "--show-current") or run_git(cwd, "rev-parse", "--short", "HEAD")`,
    to: String.raw`def _no_git_here(cwd: str) -> bool:
    """Sparklebot: True when git cannot find a repo at *cwd*: no .git entry and no HEAD file (a bare repo, or
    a cwd inside a git dir) in it or any parent, on its own path or on its resolved one (a symlink or junction
    into a checkout), and no GIT_DIR or GIT_WORK_TREE set. Lets branch() skip its two failing git spawns
    (~150 ms each on Windows) for a non-repo cwd, such as the home folder Bot Chat opens in on every bot
    switch. Stats only, nothing cached: a git init shows on the next call. Any doubt answers False, and git
    decides as before."""
    if os.environ.get("GIT_DIR") or os.environ.get("GIT_WORK_TREE"):
        return False
    try:
        start = os.path.abspath(cwd)
        for path in {start, os.path.realpath(start)}:
            while True:
                if os.path.lexists(os.path.join(path, ".git")) or os.path.lexists(os.path.join(path, "HEAD")):
                    return False
                parent = os.path.dirname(path)
                if parent == path:
                    break
                path = parent
        return True
    except (OSError, TypeError, ValueError):
        return False


def branch(cwd: str) -> str:
    if cwd and _no_git_here(cwd):  # Sparklebot: no repo can be there, so no git spawn
        return ""
    return run_git(cwd, "branch", "--show-current") or run_git(cwd, "rev-parse", "--short", "HEAD")`
  },
  // 2. Capabilities: group the skill catalog once instead of filtering it once per category, and rank
//    outside the sort comparator. Measured 25.11.2026: the window froze ~2.6 s on every open.
//    Test: apps/desktop/src/app/capabilities/catalog/catalog-discovery-layout.test.tsx
  // Imports useMemo for the memoized layout. The list stays in perfectionist's natural sort order.
  {
    file: 'apps/desktop/src/app/capabilities/catalog/catalog-discovery.tsx',
    from: String.raw`import { type ReactNode, useState } from 'react'`,
    to: String.raw`import { type ReactNode, useMemo, useState } from 'react'`
  },
  // Gives the same shelf rank: Math.max applied pair by pair equals Math.max over all values, including NaN, -0
  // and coercion. It avoids the temporary array. The old spread threw RangeError on a shelf above about 125k
  // entries (main-thread stack, Node 26); the new test pins this.
  {
    file: 'apps/desktop/src/app/capabilities/catalog/catalog-discovery.tsx',
    from: String.raw`/** A shelf ranks by its most-starred entry, so the strongest categories lead. */
const topStars = (items: CatalogEntry[]) => Math.max(-1, ...items.map(entry => entry.stars ?? -1))`,
    to: String.raw`/** A shelf ranks by its most-starred entry, so the strongest categories lead.
 *  Sparklebot: a fold instead of Math.max(-1, ...stars): same value, no temporary array and no
 *  call argument per entry (V8 throws RangeError past ~120k spread arguments). */
const topStars = (items: CatalogEntry[]) => items.reduce((top, entry) => Math.max(top, entry.stars ?? -1), -1)`
  },
  // Adds a pure, exported layout helper next to the component. It groups entries by category in one Map pass,
  // replacing the upstream filter per category, which was O(categories x entries) and about 2.0 s of self time.
  // It ranks each shelf once before a stable sort. Category keys are always strings, so Map's SameValueZero
  // equals ===. The output is identical: verified against upstream copied verbatim across 48 generated layouts
  // and 5 rendered pages.
  {
    file: 'apps/desktop/src/app/capabilities/catalog/catalog-discovery.tsx',
    from: String.raw`/** Rows of the mixed "More to explore" shelf shown at first, and per "Show more". */
const LOOSE_ROWS_PAGE = 3`,
    to: String.raw`/** Rows of the mixed "More to explore" shelf shown at first, and per "Show more". */
const LOOSE_ROWS_PAGE = 3

/** Sparklebot: everything the page shows (hero picks, tier shelves, category shelves, the mixed
 *  shelf) in passes linear in the entries. Upstream filtered every entry once per category and
 *  recomputed both shelves' ranks inside the sort comparator: a ~2.6 s freeze on each
 *  Capabilities open with the full skills feed. Same shelves, cards and order, ties included:
 *  buckets keep feed order and the stable sort compares the same ranks. */
export function discoveryLayout(entries: CatalogEntry[], kind: CatalogKind, narrowed?: boolean, byCategory?: boolean) {
  // Same pick as the website: curated ranks from the feed, rotated weekly.
  // Every curated pick, this week's first; more than one becomes a slider.
  const featured = narrowed ? [] : featuredPicks(entries, entry => ({
    featured: entry.featured,
    official: kind === 'plugins' ? pluginTier(entry) === 'official' : isOfficialSkillSource(entry.source),
    pictured: Boolean(entry.imageUrl),
    addedAt: entry.addedAt,
    stars: entry.stars
  }))

  // A slide leaves its shelf, as the single hero always did.
  const others = entries.filter(entry => !featured.includes(entry))
  const tiered = kind === 'plugins' && !byCategory ? PLUGIN_TIERS.map(tier => ({ tier, items: others.filter(entry => pluginTier(entry) === tier) })).filter(({ items }) => items.length) : []
  const remaining = kind === 'plugins' && !byCategory ? others.filter(entry => pluginTier(entry) === 'community') : others
  const grouped: [string, string, CatalogEntry[]][] = []

  if (kind === 'plugins') {
    // Plugins with an unlisted category land in ${'`'}general${'`'}, as in every other plugin grouping.
    for (const [key, items] of groupCatalogPlugins(remaining)) {
      grouped.push([key, PLUGIN_CATEGORIES[key].label, items])
    }
  } else {
    // One pass into per-category buckets (feed order kept); labels and order as the category facet.
    const buckets = new Map<string, CatalogEntry[]>()

    for (const entry of remaining) {
      const bucket = buckets.get(entry.category)

      if (bucket) {
        bucket.push(entry)
      } else {
        buckets.set(entry.category, [entry])
      }
    }

    for (const [key, meta] of catalogCategories(remaining)) {
      grouped.push([key, meta.label, buckets.get(key) ?? []])
    }
  }

  // Each shelf's rank once, then a stable sort on it: equal ranks keep the order above.
  const sections = grouped
    .map(section => ({ section, stars: topStars(section[2]) }))
    .sort((a, b) => b.stars - a.stars)
    .map(({ section }) => section)

  // A category too small to fill a row reads as a stray full-width strip; those
  // fold into one mixed shelf at the end instead.
  // (A category the user picked always gets its own shelf, however small.)
  const minShelf = byCategory ? 1 : MIN_SHELF
  const shelves = sections.filter(([, , items]) => items.length >= minShelf)
  const loose = sections.filter(([, , items]) => items.length < minShelf).flatMap(([, , items]) => items)

  return { featured, tiered, shelves, loose }
}`
  },
  // The component now gets its layout from the helper, memoized on exactly the props the derivation reads. Tier
  // objects keep the same keys in the same order. I ran babel-plugin-react-compiler 1.0.0 on the patched file.
  // It compiles without bailing out, and the layout scope is keyed only on byCategory, entries, kind and
  // narrowed. Upstream's compiled scope, confirmed in the shipped dist bundle, was also keyed on card,
  // categoryLimit, looseRows, onCategory, t.catalog and title. So every 'Show more' click re-ran the 2 s
  // derivation.
  {
    file: 'apps/desktop/src/app/capabilities/catalog/catalog-discovery.tsx',
    from: String.raw`  // Same pick as the website: curated ranks from the feed, rotated weekly.
  // Every curated pick, this week's first; more than one becomes a slider.
  const featured = narrowed ? [] : featuredPicks(entries, entry => ({
    featured: entry.featured,
    official: kind === 'plugins' ? pluginTier(entry) === 'official' : isOfficialSkillSource(entry.source),
    pictured: Boolean(entry.imageUrl),
    addedAt: entry.addedAt,
    stars: entry.stars
  }))

  // A slide leaves its shelf, as the single hero always did.
  const others = entries.filter(entry => !featured.includes(entry))
  const tiered = kind === 'plugins' && !byCategory ? PLUGIN_TIERS.map(tier => ({ tier, ...t.catalog.tiers[tier], items: others.filter(entry => pluginTier(entry) === tier) })).filter(({ items }) => items.length) : []
  const remaining = kind === 'plugins' && !byCategory ? others.filter(entry => pluginTier(entry) === 'community') : others

  // Plugins with an unlisted category land in ${'`'}general${'`'}, as in every other plugin grouping.
  const sections: [string, string, CatalogEntry[]][] = (
    kind === 'plugins'
      ? groupCatalogPlugins(remaining).map(([key, items]) => [key, PLUGIN_CATEGORIES[key].label, items] as [string, string, CatalogEntry[]])
      : catalogCategories(remaining).map(([key, meta]) => [key, meta.label, remaining.filter(entry => entry.category === key)] as [string, string, CatalogEntry[]])
  ).sort((a, b) => topStars(b[2]) - topStars(a[2]))

  // A category too small to fill a row reads as a stray full-width strip; those
  // fold into one mixed shelf at the end instead.
  // (A category the user picked always gets its own shelf, however small.)
  const minShelf = byCategory ? 1 : MIN_SHELF
  const shelves = sections.filter(([, , items]) => items.length >= minShelf)
  const loose = sections.filter(([, , items]) => items.length < minShelf).flatMap(([, , items]) => items)
`,
    to: String.raw`  // Sparklebot: the layout once per input, not again on every render ("Show more", parent renders).
  const layout = useMemo(() => discoveryLayout(entries, kind, narrowed, byCategory), [byCategory, entries, kind, narrowed])
  const { featured, shelves, loose } = layout
  const tiered = layout.tiered.map(({ tier, items }) => ({ tier, ...t.catalog.tiers[tier], items }))
`
  },
  // 3. Messaging: one GET /api/messaging/platforms reads the gateway config and liveness once, not once
//    per platform. Measured 25.11.2026: 6 to 24 s per open.
//    Test: tests/hermes_cli/test_web_messaging_platforms_shared_reads.py
  // Adds the request-memo helper next to its first caller. It computes once per memo and replays a stored
  // failure with its original traceback. Also adds an optional request_memo parameter (default None) to
  // _platform_enablement, so other callers behave as before.
  {
    file: 'hermes_cli/web_routers/messaging.py',
    from: String.raw`def _platform_enablement(
    platform_id: str, entry: dict[str, Any], env_on_disk: dict[str, str], scoped: bool,
    source_keys: Collection[str] = (),
) -> tuple[bool, bool, dict | None]:
`,
    to: String.raw`# Sparklebot: one Channels request reads the gateway config and the gateway's liveness once and shares
# them across its ~30 platform rows; every row used to repeat load_gateway_config() (6-24 s per page open).
# The memo is a plain dict ${'`'}${'`'}_platform_payloads${'`'}${'`'} makes for that one call: nothing outlives the request.
def _request_memo(memo: Optional[dict], key: str, compute):
    """${'`'}${'`'}compute()${'`'}${'`'} once per ${'`'}${'`'}memo${'`'}${'`'}; its result, or the exception it raised, replays to every later
    caller, so each row keeps its own fallback. Without a memo it just runs, as before."""
    if memo is None:
        return compute()
    if key not in memo:
        try:
            memo[key] = (compute(), None, None)
        except Exception as exc:  # health: allow BLE001 -- stored, then re-raised below to each caller's own handler
            memo[key] = (None, exc, exc.__traceback__)
    value, error, tb = memo[key]
    if error is not None:
        raise error.with_traceback(tb)
    return value


def _platform_enablement(
    platform_id: str, entry: dict[str, Any], env_on_disk: dict[str, str], scoped: bool,
    source_keys: Collection[str] = (), request_memo: Optional[dict] = None,
) -> tuple[bool, bool, dict | None]:
`
  },
  // The unscoped arm (the default bot) reuses the request's single gateway config load. The 25.11 samples put
  // 15.3 s of 16.3 s here. The line stays inside the row's own try/except, so a failure gives the same per-row
  // fallback as before.
  {
    file: 'hermes_cli/web_routers/messaging.py',
    from: String.raw`        gateway_config = load_gateway_config()
        platform = Platform(platform_id)
`,
    to: String.raw`        gateway_config = _request_memo(request_memo, "gateway_config", load_gateway_config)  # Sparklebot: shared
        platform = Platform(platform_id)
`
  },
  // The relay-disabled lookup takes the same memo, default None. Changed from the proposal: added the required
  // '# Sparklebot:' marker line.
  {
    file: 'hermes_cli/web_routers/messaging.py',
    from: String.raw`def _relay_disabled_platform_ids(scoped: bool) -> frozenset[str]:
`,
    to: String.raw`# Sparklebot: takes the request memo, so this label and every row share one gateway config load.
def _relay_disabled_platform_ids(scoped: bool, request_memo: Optional[dict] = None) -> frozenset[str]:
`
  },
  // This load already ran first in each request, before any row. It is now the one load every row reuses, so
  // loads per request drop from rows+1 (32) to 1.
  {
    file: 'hermes_cli/web_routers/messaging.py',
    from: String.raw`        platforms = load_gateway_config().platforms
`,
    to: String.raw`        platforms = _request_memo(request_memo, "gateway_config", load_gateway_config).platforms  # Sparklebot: shared
`
  },
  // Adds an optional keyword memo to the row builder. Direct callers are unchanged.
  {
    file: 'hermes_cli/web_routers/messaging.py',
    from: String.raw`    relay_disabled: frozenset[str] = frozenset(), relay_view: tuple[frozenset[str], bool] = (frozenset(), False),
) -> dict[str, Any]:
`,
    to: String.raw`    relay_disabled: frozenset[str] = frozenset(), relay_view: tuple[frozenset[str], bool] = (frozenset(), False),
    request_memo: Optional[dict] = None,  # Sparklebot: reads shared by every row of one request (_request_memo)
) -> dict[str, Any]:
`
  },
  // Liveness depends only on profile_home, runtime and the module-level health URL, and all three are the same
  // for every row of one _platform_payloads call. No row mutates runtime. It now runs once per request instead
  // of 31 times, which matters most when _GATEWAY_HEALTH_URL makes it an HTTP probe.
  {
    file: 'hermes_cli/web_routers/messaging.py',
    from: String.raw`    gateway_running = resolve_gateway_liveness(
        profile_dir=profile_home, runtime=runtime,
        health_probe=_probe_gateway_health if _GATEWAY_HEALTH_URL else None,
        pid_probe=get_running_pid_cached, runtime_reader=read_runtime_status,
        runtime_pid_probe=get_runtime_status_running_pid,
    ).running
`,
    to: String.raw`    # Sparklebot: profile_home and runtime are the same for every row of one request, so one verdict serves all.
    gateway_running = _request_memo(request_memo, "gateway_running", lambda: resolve_gateway_liveness(
        profile_dir=profile_home, runtime=runtime,
        health_probe=_probe_gateway_health if _GATEWAY_HEALTH_URL else None,
        pid_probe=get_running_pid_cached, runtime_reader=read_runtime_status,
        runtime_pid_probe=get_runtime_status_running_pid,
    ).running)
`
  },
  // Passes the memo by keyword. The existing test doubles (lambda *a, **k) in
  // test_served_profile_mirror_platforms.py still fit.
  {
    file: 'hermes_cli/web_routers/messaging.py',
    from: String.raw`    enabled, configured, home_channel = _platform_enablement(platform_id, entry, env_on_disk, scoped, source_keys)
`,
    to: String.raw`    enabled, configured, home_channel = _platform_enablement(platform_id, entry, env_on_disk, scoped, source_keys,
                                                             request_memo=request_memo)  # Sparklebot: shared reads
`
  },
  // Creates the request-local memo and passes it to the relay lookup and to every row, in the same call order
  // as before. It is dropped on return. The POST .../{id}/test route also goes through here and gets its own
  // memo.
  {
    file: 'hermes_cli/web_routers/messaging.py',
    from: String.raw`    relay_disabled = _relay_disabled_platform_ids(scoped)
    relay_view = _relay_channel_view(own_home)
    return [_messaging_platform_payload(entry, env_on_disk, runtime, scoped=scoped, profile_home=scoped_dir,
                                        source_keys=source_keys, relay_disabled=relay_disabled,
                                        relay_view=relay_view)
            for entry in entries]
`,
    to: String.raw`    # Sparklebot: one memo per call, so the gateway config and liveness are read once instead of once per row.
    request_memo: dict = {}
    relay_disabled = _relay_disabled_platform_ids(scoped, request_memo=request_memo)
    relay_view = _relay_channel_view(own_home)
    return [_messaging_platform_payload(entry, env_on_disk, runtime, scoped=scoped, profile_home=scoped_dir,
                                        source_keys=source_keys, relay_disabled=relay_disabled,
                                        relay_view=relay_view, request_memo=request_memo)
            for entry in entries]
`
  }
]
