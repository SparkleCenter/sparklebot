"""Main's banner / status-bar inventory for a canonical local session.

``tui_gateway/server.py::_session_info`` on main put the session's tools (by toolset), skills (by
category), MCP servers, version / release date, update notice, git branch, project and provider on
every ``session.info`` / create / resume ``info``; the Ink banner (``components/branding.tsx``) and
the classic CLI banner (``hermes_cli/banner.py::build_welcome_banner``) render them. A canonical
session's agent is built on its first turn, so the inventory is computed here from the session's
frozen policy (the toolsets that turn will run with), with main's own builders, in the owner
process. Every builder does I/O (skills tree walk, tool ``check_fn`` probes, git), so callers run
:func:`session_inventory` off the owner loop (:func:`snapshot_info`).
"""
from __future__ import annotations

import asyncio
import contextlib
import logging

logger = logging.getLogger(__name__)

_update_prefetch_started = False


def _start_update_prefetch():
    """Main's TUI gateway started the passive update check at import; the owner starts it once,
    on the first snapshot, so ``update_behind`` reports like main's banner instead of staying null."""
    global _update_prefetch_started
    if _update_prefetch_started:
        return
    _update_prefetch_started = True
    from hermes_cli.banner import prefetch_update_check
    prefetch_update_check()


def _grouped(tools):
    """``{toolset: [tool names]}`` exactly as main's ``_session_info`` grouped ``agent.tools``."""
    from model_tools import get_toolset_for_tool
    grouped: dict[str, list[str]] = {}
    for tool in tools or []:
        name = tool["function"]["name"]
        grouped.setdefault(get_toolset_for_tool(name) or "other", []).append(name)
    return grouped


def _policy_tools(policy, config):
    """The tool list the session's next agent build loads (``agent/agent_init.py`` tool snapshot):
    the policy's toolsets minus the configured, platform-gated and one-shot disabled ones."""
    import model_tools
    from agent.skill_utils import parse_config_string_list
    from toolsets import session_disabled_toolsets, session_platform_tool_drops
    enabled = list(policy.current_toolsets(config))
    disabled = session_disabled_toolsets(
        parse_config_string_list((config.get("agent") or {}).get("disabled_toolsets")) or None, policy.platform,
        oneshot=policy.source == "oneshot")
    tools = model_tools.get_tool_definitions(enabled_toolsets=enabled, disabled_toolsets=disabled, quiet_mode=True)
    drops = set(session_platform_tool_drops(policy.platform))
    return enabled, [tool for tool in tools or [] if tool["function"]["name"] not in drops]


def _project(cwd):
    """``tui_gateway/server.py::_project_info_for_cwd``: the named project owning *cwd*, or None."""
    if not str(cwd or "").strip():
        return None
    from hermes_cli import projects_db as pdb
    try:
        with pdb.connect_closing() as conn:
            project = pdb.project_for_path(conn, cwd)
    except Exception:  # health: allow BLE001 -- main's resolver: an unreadable projects.db names no project
        logger.debug("failed to resolve project for cwd", exc_info=True)
        return None
    return None if project is None else {
        "id": project.id, "slug": project.slug, "name": project.name, "primary_path": project.primary_path}


def _cli_startup_notices(enabled):
    """The lines main's HermesCLI printed under its banner, computed where the tools run: the toolset
    availability warning (``cli.py::_show_tool_availability_warnings``). The classic CLI renders them
    with its own console."""
    notices: dict = {"tool_availability_warnings": []}
    with contextlib.suppress(Exception):
        from hermes_cli.tool_availability_notices import (
            current_terminal_backend, filter_to_enabled_toolsets, tool_availability_warning_lines)
        from model_tools import check_tool_availability
        from tools.terminal_tool import terminal_backend_unavailable_reason
        from toolsets import resolve_toolset
        _, unavailable = check_tool_availability()
        unavailable = filter_to_enabled_toolsets(unavailable, enabled or [], resolve_toolset)
        notices["tool_availability_warnings"] = tool_availability_warning_lines(
            unavailable, terminal_reason=terminal_backend_unavailable_reason(),
            terminal_backend=current_terminal_backend())
    return notices


def _unknown_toolsets(enabled, config):
    """Main's "Unknown toolsets" startup warning (``HermesCLI._init_toolsets``), judged where the plugins
    load: the session's toolset names the profile's registry, MCP servers, plugin toolsets and platform
    bundles cannot place (an uninstalled plugin's stale ``platform_toolsets`` entry)."""
    if "all" in enabled or "*" in enabled:
        return []
    with contextlib.suppress(Exception):
        from hermes_cli.toolset_validation import saved_toolset_resolver
        known = saved_toolset_resolver(config)
        return [name for name in enabled if not known(name)]
    return []


def _cli_skills():
    """``hermes_cli.banner.get_available_skills`` as main's classic CLI computed it: ``cmd_chat`` pins
    ``HERMES_KANBAN_BOARD`` before HermesCLI starts, so ``environments: [kanban]`` skills are offered.
    The owner never sets that env; the kanban relevance is scoped to this scan (a ContextVar) and the
    catalog cache entry it would poison is restored, so other surfaces keep their own view."""
    from tools import skills_tool
    from tools.kanban_toolset_context import scoped_kanban_toolset_selection
    key = ("filtered", False)
    saved = skills_tool._SKILLS_CACHE.pop(key, None)
    try:
        with scoped_kanban_toolset_selection(["kanban"]):
            found = skills_tool.find_all_skills()
    finally:
        skills_tool._SKILLS_CACHE.pop(key, None)
        if saved is not None:
            skills_tool._SKILLS_CACHE[key] = saved
    grouped: dict[str, list[str]] = {}
    for skill in found:
        grouped.setdefault(skill.get("category") or "general", []).append(skill["name"])
    return grouped


def _session_provider(view, config=None):
    from hermes_cli.runtime_provider_custom import session_provider_identity
    return session_provider_identity(getattr(view, "provider", None), getattr(view, "requested_provider", None),
                                     getattr(view, "base_url", None), getattr(view, "model", None), config=config)


# Sparklebot: a bot switch (session.resume) rebuilt this whole inventory, and its tool snapshot, toolset
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


def session_inventory(authority, policy, agent, cwd):
    """Main's banner/status fields for one session. Each section degrades to main's empty value on
    its own, so one failing builder never blanks the others (main wrapped each in ``suppress``)."""
    from gateway.session_authorities import owner_scope
    from tui_gateway import git_probe
    info: dict = {"tools": {}, "skills": {}, "mcp_servers": [], "version": "", "release_date": "",
                  "update_behind": None, "update_command": "",
                  "branch": git_probe.branch(cwd) if cwd else "", "project": _project(cwd)}
    with owner_scope(authority):
        config = policy.config(authority, secrets=False) if policy is not None else {}
        sb_key = _sb_inventory_key(config)  # Sparklebot: shared part of the inventory cache keys
        if agent is not None:
            from agent.voice_turn_route import session_runtime_view
            info["provider"] = _session_provider(session_runtime_view(agent), config if policy is not None else None)
            info["tools"] = _grouped(getattr(agent, "tools", None))
            info["system_prompt"] = getattr(agent, "_cached_system_prompt", "") or ""
            compressor = getattr(agent, "context_compressor", None)
            if compressor is not None and getattr(compressor, "context_length", None):
                info["context_length"] = compressor.context_length
            enabled = list(getattr(agent, "enabled_toolsets", None) or [])
        else:
            info["provider"] = str((config.get("model") or {}).get("provider") or "")
            enabled = []
            if policy is not None:
                try:
                    # Sparklebot: cached per policy (_sb_cached).
                    enabled, info["tools"] = _sb_cached(
                        _sb_key(sb_key, "tools", policy), lambda: _sb_policy_tool_names(policy, config))
                except Exception:  # health: allow BLE001 -- main's suppress: the banner shows no tools, not an error
                    logger.warning("session inventory: tool snapshot failed", exc_info=True)
        info["enabled_toolsets"] = sorted(enabled)
        with contextlib.suppress(Exception):
            # The classic CLI banner colours lazy (yellow) / disabled (red) tools from this.
            from hermes_cli.banner import compute_toolset_availability
            # Sparklebot: cached per enabled toolset set (_sb_cached).
            info["tool_availability"] = _sb_cached(
                _sb_key(sb_key, "availability", tuple(sorted(map(str, enabled)))),
                lambda: compute_toolset_availability(enabled))
        if policy is not None and policy.source == "cli":
            info.update(_cli_startup_notices(enabled), unknown_toolsets=_unknown_toolsets(enabled, config))
        with contextlib.suppress(Exception):
            # Sparklebot: the two skill builders, cached per skills signature (_sb_cached); an empty
            # result (a failed scan reads the same) is not kept.
            cli_surface = policy is not None and policy.source == "cli"
            skills_key = _sb_key(sb_key, "skills", cli_surface, _sb_skills_sig())
            info["skills"] = _sb_cached(
                skills_key, _cli_skills if cli_surface else lambda: _sb_banner_skills(skills_key is not None),
                keep=bool)
        with contextlib.suppress(Exception):
            from tools.mcp_tool_discovery import get_mcp_status
            info["mcp_servers"] = get_mcp_status()
    with contextlib.suppress(Exception):
        from hermes_cli import __release_date__
        from hermes_cli.version_info import get_version_info
        info.update(version=get_version_info().base_version, release_date=__release_date__)
    with contextlib.suppress(Exception):
        from hermes_cli.banner import get_update_result
        from hermes_cli.config import recommended_update_command
        _start_update_prefetch()
        # Two assignments, as on main: a failing command lookup still reports update_behind.
        info["update_behind"] = get_update_result(timeout=0.5)
        info["update_command"] = recommended_update_command()
    return info


async def snapshot_info(authority, ref):
    """``local_session_info`` plus main's inventory, the builders run off the owner loop."""
    from gateway.session_local import local_session_info
    from gateway.session_policy import policy_for_source
    info = local_session_info(authority, ref)
    policy = policy_for_source(authority.runner, authority.sessions[ref.session_id].source)
    agent = authority.agent(ref)
    inventory = await asyncio.to_thread(session_inventory, authority, policy, agent, info.get("cwd"))
    if info.get('tool_count') is None:
        # A lazy session: the tools its first turn loads (the banner's own count).
        info['tool_count'] = sum(len(names) for names in (inventory.get('tools') or {}).values())
    from gateway.session_usage import snapshot_usage
    if (usage := await asyncio.to_thread(snapshot_usage, authority, ref, agent)) is not None:
        info['usage'] = usage
    return {**inventory, **info}


def agent_inventory(agent) -> dict:
    """The banner fields only a built agent knows (main's ``_session_info`` read them off it): the
    tools it loaded, its cached system prompt (the ``▸ System Prompt`` row), provider and context
    length. Cheap attribute reads, safe on the agent thread at turn end."""
    info: dict = {}
    with contextlib.suppress(Exception):
        from agent.voice_turn_route import session_runtime_view
        info["provider"] = _session_provider(session_runtime_view(agent))
    with contextlib.suppress(Exception):
        info["tools"] = _grouped(getattr(agent, "tools", None))
    info["system_prompt"] = getattr(agent, "_cached_system_prompt", "") or ""
    compressor = getattr(agent, "context_compressor", None)
    if compressor is not None and getattr(compressor, "context_length", None):
        info["context_length"] = compressor.context_length
    return info


def publish_settled_info(turn, agent) -> None:
    """Main's end-of-turn ``session.info`` (``session_workdir._emit_settled_session_info``) for a local
    viewer: the first turn builds the agent, so this is when the banner's ``▸ System Prompt`` row, the
    agent's tool list and provider first become known. Never breaks the turn.

    A ``model_override`` admission (``/model --once``, ``/moa``) built its agent on the one-turn
    route. That agent must not become the route Desktop, the TUI, and resume read. Drop it from
    the cache (released once this turn's running slot clears) and publish the model and provider
    of the policy route, both from one read of the profile."""
    if agent is None:
        return
    with contextlib.suppress(Exception):
        from gateway.session_cli_turn import cli_turn
        from gateway.session_contract import SessionRef
        from gateway.session_local import local_session_info
        from gateway.session_policy import policy_for_source
        authority, session_id, _generation = turn._approval_owner
        message_id = getattr(getattr(turn, "_ctx", None), "inbound_message_id", None)
        one_turn = bool(cli_turn(message_id).get("model_override"))
        live = None
        if one_turn:
            sessions = getattr(authority, "sessions", None)
            live = sessions.get(session_id) if hasattr(sessions, "get") else None
            evict = getattr(getattr(turn, "_runner", None), "_evict_cached_agent", None)
            if live is not None and callable(evict):
                try:
                    evict(live.route, release_after_turn=True)
                except Exception:
                    logger.debug("one-turn agent cache drop failed", exc_info=True)
        ref = SessionRef(authority.profile_id, session_id)
        info = {**agent_inventory(agent), **local_session_info(authority, ref)}
        if one_turn and live is not None:
            try:
                runner = getattr(authority, "runner", None) or turn._runner
                policy = policy_for_source(runner, live.source)
            except Exception:
                logger.debug("one-turn policy route unavailable", exc_info=True)
                policy = None
            if policy is not None:
                config, info["model"] = policy.effective(authority, secrets=False)
                section = config.get("model")
                provider = section.get("provider") if isinstance(section, dict) else None
                if provider:
                    info["provider"] = provider
        turn._publish_execution("session.info", info)
