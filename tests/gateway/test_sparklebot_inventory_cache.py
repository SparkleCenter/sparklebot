"""Sparklebot: a bot switch (``session.resume``) reuses the banner inventory's heavy sections (tool snapshot,
toolset availability, skills scan) instead of rebuilding them, and a non-repo cwd costs no ``git`` spawn.

Freshness contract: the first request after a change the cache key can see (config, .env, process env,
tool registry, check_fn epoch, a skill dir or SKILL.md, the profile) rebuilds; the rest expires with
``_SB_INVENTORY_TTL_S``. The cache is per profile, off where model_tools keeps its own memo off, and safe
under concurrent callers."""
import os
import shutil
import subprocess
import threading
from types import SimpleNamespace

import pytest

from gateway import session_local_inventory as inv
from tui_gateway import git_probe


@pytest.fixture(autouse=True)
def _empty_inventory_cache(monkeypatch):
    monkeypatch.setattr(inv, "_sb_inventory", {})
    monkeypatch.setattr(inv, "_sb_inventory_gates", {})


# --- the cache itself ---------------------------------------------------------------------------------


def test_a_key_is_built_once_and_callers_get_copies():
    calls = []

    def build():
        calls.append(1)
        return {"file": ["read_file"]}

    first = inv._sb_cached(("k",), build)
    first["file"].append("changed by a caller")
    assert inv._sb_cached(("k",), build) == {"file": ["read_file"]}
    assert calls == [1]


def test_unknown_or_unhashable_key_parts_build_every_time():
    assert inv._sb_key("base", None) is None
    assert inv._sb_key(None, "tools") is None
    assert inv._sb_key("base", {"unhashable": 1}) is None
    calls = []
    for _ in range(2):
        inv._sb_cached(None, lambda: calls.append(1))
    assert len(calls) == 2


def test_an_entry_lives_for_the_ttl_only(monkeypatch):
    assert inv._SB_INVENTORY_TTL_S <= 30.0  # no longer than the check_fn verdicts under it
    calls = []
    inv._sb_cached(("k",), lambda: calls.append(1) or "v")
    inv._sb_cached(("k",), lambda: calls.append(1) or "v")
    assert len(calls) == 1
    monkeypatch.setattr(inv, "_SB_INVENTORY_TTL_S", 0.0)
    inv._sb_cached(("k",), lambda: calls.append(1) or "v")
    assert len(calls) == 2


def test_failed_or_rejected_builds_are_not_kept():
    def boom():
        raise RuntimeError("scan failed")

    with pytest.raises(RuntimeError):
        inv._sb_cached(("k",), boom)
    assert inv._sb_cached(("k",), lambda: {"a": ["b"]}) == {"a": ["b"]}
    calls = []
    for _ in range(2):
        assert inv._sb_cached(("empty",), lambda: calls.append(1) or {}, keep=bool) == {}
    assert len(calls) == 2
    assert not inv._sb_inventory_gates


def test_concurrent_callers_of_one_key_share_one_build():
    started, release, calls, results = threading.Event(), threading.Event(), [], []

    def build():
        calls.append(1)
        started.set()
        release.wait(10)
        return ["x"]

    def ask():
        results.append(inv._sb_cached(("k",), build))

    threads = [threading.Thread(target=ask) for _ in range(4)]
    for thread in threads:
        thread.start()
    assert started.wait(10)
    release.set()
    for thread in threads:
        thread.join(10)
    assert calls == [1]
    assert results == [["x"]] * 4
    assert not inv._sb_inventory_gates


def test_the_size_cap_drops_the_oldest(monkeypatch):
    monkeypatch.setattr(inv, "_SB_INVENTORY_MAX", 2)
    for name in ("a", "b", "c"):
        inv._sb_cached((name,), lambda: name)
    assert list(inv._sb_inventory) == [("b",), ("c",)]


# --- what the key sees --------------------------------------------------------------------------------


def test_shared_key_follows_profile_config_files_env_registry_and_check_fn_epoch(tmp_path, monkeypatch):
    from hermes_constants import get_hermes_home, reset_hermes_home_override, set_hermes_home_override
    from tools import registry as reg

    config = {"platform_toolsets": {"cli": ["file", "terminal"]}}
    base = inv._sb_inventory_key(config)
    assert base is not None
    assert inv._sb_inventory_key(dict(config)) == base
    assert inv._sb_inventory_key({"platform_toolsets": {"cli": ["web"]}}) != base

    home = get_hermes_home()
    home.mkdir(parents=True, exist_ok=True)
    (home / ".env").write_text("SPARKLEBOT_PROBE_KEY=1\n", encoding="utf-8")
    after_env_file = inv._sb_inventory_key(config)
    assert after_env_file != base
    (home / "config.yaml").write_text("display: {skin: default}\n", encoding="utf-8")
    after_config_file = inv._sb_inventory_key(config)
    assert after_config_file != after_env_file

    monkeypatch.setenv("SPARKLEBOT_PROBE_KEY", "1")
    after_env = inv._sb_inventory_key(config)
    assert after_env != after_config_file
    monkeypatch.setattr(reg.registry, "_generation", reg.registry._generation + 1)
    after_registry = inv._sb_inventory_key(config)
    assert after_registry != after_env
    monkeypatch.setattr(reg, "_check_fn_epoch", reg._check_fn_epoch + 1)
    assert inv._sb_inventory_key(config) != after_registry

    other = tmp_path / "bot-b"
    other.mkdir()
    token = set_hermes_home_override(str(other))  # another bot (profile) served by the same process
    try:
        other_key = inv._sb_inventory_key(config)
    finally:
        reset_hermes_home_override(token)
    assert other_key is not None
    assert other_key != inv._sb_inventory_key(config)


def test_an_agent_build_writing_its_session_id_keeps_the_key(monkeypatch):
    # agent_init / compression write HERMES_SESSION_ID into os.environ on every build: it must not void
    # every bot's entries.
    monkeypatch.setenv("HERMES_SESSION_ID", "first")
    before = inv._sb_inventory_key({})
    monkeypatch.setenv("HERMES_SESSION_ID", "second")
    assert inv._sb_inventory_key({}) == before


def test_no_caching_where_model_tools_keeps_its_own_memo_off(monkeypatch):
    from tools import registry as reg
    from tools.environments import sandbox_scope

    assert inv._sb_inventory_key({}) is not None
    with monkeypatch.context() as patch:
        patch.setattr(reg, "check_fn_cache_scope", lambda: reg.CHECK_FN_CACHE_BYPASS)
        assert inv._sb_inventory_key({}) is None  # a routed process with no profile identity bound
    with monkeypatch.context() as patch:
        patch.setattr(sandbox_scope, "hosted_scope", lambda: object())
        assert inv._sb_inventory_key({}) is None  # a hosted tenant
    assert inv._sb_inventory_key({}) is not None


def test_skills_signature_sees_an_install_and_an_in_place_edit():
    from hermes_constants import get_hermes_home

    skill = get_hermes_home() / "skills" / "research" / "arxiv"
    skill.mkdir(parents=True)
    md = skill / "SKILL.md"
    md.write_text("---\nname: arxiv\ndescription: a.\n---\n", encoding="utf-8")
    before = inv._sb_skills_sig()
    assert before is not None
    assert inv._sb_skills_sig() == before

    # An editor's in-place save moves no directory: only the file's own stat shows it.
    dir_stat = os.stat(skill)
    md.write_text("---\nname: arxiv-papers\ndescription: a longer description.\n---\n", encoding="utf-8")
    os.utime(skill, ns=(dir_stat.st_atime_ns, dir_stat.st_mtime_ns))
    edited = inv._sb_skills_sig()
    assert edited != before

    added = get_hermes_home() / "skills" / "research" / "pdf"
    added.mkdir()
    (added / "SKILL.md").write_text("---\nname: pdf\ndescription: b.\n---\n", encoding="utf-8")
    assert inv._sb_skills_sig() != edited


def test_a_cache_miss_rescans_the_skills_catalog_under_a_routed_profile(tmp_path, monkeypatch):
    # Under a routed profile banner reads the skills catalog cache, whose dir signature cannot see an
    # in-place SKILL.md edit: a miss of the inventory cache drops that entry, so the scan reads the files.
    from hermes_cli import banner
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    from tools import skills_tool

    entry = ("filtered", False)
    seen = []
    monkeypatch.setattr(banner, "get_available_skills",
                        lambda: seen.append(entry in skills_tool._SKILLS_CACHE) or {"research": ["arxiv"]})
    monkeypatch.setitem(skills_tool._SKILLS_CACHE, entry, ("an older signature", 0.0, []))
    assert inv._sb_banner_skills(True) == {"research": ["arxiv"]}  # the launch profile: banner memo, as before
    token = set_hermes_home_override(str(tmp_path))
    try:
        inv._sb_banner_skills(False)  # uncached: the plain call, as before
        inv._sb_banner_skills(True)
    finally:
        reset_hermes_home_override(token)
    assert seen == [True, True, False]


def test_a_renamed_skills_catalog_cache_falls_back_to_the_plain_call(tmp_path, monkeypatch):
    # A future Hermes may rename the private catalog cache; the bot must still list its skills.
    from hermes_cli import banner
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    from tools import skills_tool

    monkeypatch.setattr(banner, "get_available_skills", lambda: {"research": ["arxiv"]})
    monkeypatch.delattr(skills_tool, "_SKILLS_CACHE")
    token = set_hermes_home_override(str(tmp_path))
    try:
        assert inv._sb_banner_skills(True) == {"research": ["arxiv"]}
    finally:
        reset_hermes_home_override(token)


def test_a_renamed_skills_catalog_cache_falls_back_to_the_plain_call(tmp_path, monkeypatch):
    # A future Hermes may rename the private catalog cache; the bot must still list its skills.
    from hermes_cli import banner
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    from tools import skills_tool

    monkeypatch.setattr(banner, "get_available_skills", lambda: {"research": ["arxiv"]})
    monkeypatch.delattr(skills_tool, "_SKILLS_CACHE")
    token = set_hermes_home_override(str(tmp_path))
    try:
        assert inv._sb_banner_skills(True) == {"research": ["arxiv"]}
    finally:
        reset_hermes_home_override(token)


# --- end to end through the owner's session RPCs ------------------------------------------------------


@pytest.mark.asyncio
async def test_session_info_reuses_the_inventory_until_what_it_shows_changes(tmp_path, monkeypatch):
    from gateway import run
    from gateway.config import GatewayConfig
    from gateway.session import SessionStore
    from gateway.session_authority import initialize_session_authority
    from gateway.session_controls import AuthorityConnection
    from hermes_cli import banner
    from tools.registry import registry

    # This test is about what the key sees; the TTL has its own test, and a slow run must not expire entries.
    monkeypatch.setattr(inv, "_SB_INVENTORY_TTL_S", 3600.0)
    home = tmp_path / "home"
    skill = home / "skills" / "research" / "arxiv"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: arxiv\ndescription: Search papers.\n---\nBody.\n", encoding="utf-8")
    (home / "config.yaml").write_text(
        'model: {default: gpt-5.4, provider: custom, base_url: "http://127.0.0.1:9/v1"}\n'
        "platform_toolsets: {cli: [file, terminal]}\n", encoding="utf-8")
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(run, "_hermes_home", home)
    monkeypatch.setattr(banner, "_available_skills_cache", None)

    counts = {"tools": 0, "availability": 0, "skills": 0}
    real_tools, real_availability = inv._policy_tools, banner.compute_toolset_availability
    real_skills = banner.get_available_skills

    def tools(*args):
        counts["tools"] += 1
        return real_tools(*args)

    def availability(*args):
        counts["availability"] += 1
        return real_availability(*args)

    def skills():
        counts["skills"] += 1
        # A multiplexed owner scans under a routed profile, where banner keeps no process-wide memo.
        monkeypatch.setattr(banner, "_available_skills_cache", None)
        return real_skills()

    monkeypatch.setattr(inv, "_policy_tools", tools)
    monkeypatch.setattr(banner, "compute_toolset_availability", availability)
    monkeypatch.setattr(banner, "get_available_skills", skills)

    store = SessionStore(tmp_path / "sessions", GatewayConfig())
    runner = SimpleNamespace(session_store=store, _session_db=store._db, adapters={}, _draining=False,
                             _cached_agent_for=lambda route: None)
    runner._adapter_for_source = lambda source: runner.adapters.get(source.platform)
    authority = await initialize_session_authority(runner, profile_id=str(home), instance_id="first")
    connection = AuthorityConnection(authority, object(), {"user_id": "human"})

    async def call(method, **params):
        reply = await connection.dispatch({"id": 1, "method": method, "params": params})
        assert "result" in reply, reply
        return reply["result"]

    created = await call("session.create", request_id="inv", source="tui", cwd=str(work))
    sid = created["session_id"]
    assert counts == {"tools": 1, "availability": 1, "skills": 1}
    first = created["info"]
    assert first["skills"].get("research") == ["arxiv"], first["skills"]
    assert "read_file" in first["tools"].get("file", []), first["tools"]

    # A bot switch back to this chat: nothing it shows changed, nothing is rebuilt, the answer is the same.
    for info in ((await call("session.info", session_id=sid)),
                 (await call("session.resume", session_id=sid))["info"]):
        assert counts == {"tools": 1, "availability": 1, "skills": 1}
        for field in ("tools", "skills", "enabled_toolsets", "tool_availability", "tool_count"):
            assert info.get(field) == first.get(field), field

    # A skill installed meanwhile shows on the very next request; the tool sections stay cached.
    added = home / "skills" / "research" / "pdf"
    added.mkdir()
    (added / "SKILL.md").write_text("---\nname: pdf\ndescription: Read PDFs.\n---\nBody.\n", encoding="utf-8")
    info = await call("session.info", session_id=sid)
    assert counts == {"tools": 1, "availability": 1, "skills": 2}
    assert sorted(info["skills"]["research"]) == ["arxiv", "pdf"], info["skills"]

    # A tool registered or removed (an MCP server connecting, a plugin) rebuilds the tool sections.
    monkeypatch.setattr(registry, "_generation", registry._generation + 1)
    await call("session.info", session_id=sid)
    assert counts == {"tools": 2, "availability": 2, "skills": 3}

    # A config.yaml edit (toolsets, MCP servers, disabled skills) rebuilds everything.
    (home / "config.yaml").write_text(
        'model: {default: gpt-5.4, provider: custom, base_url: "http://127.0.0.1:9/v1"}\n'
        "platform_toolsets: {cli: [file, terminal]}\ndisplay: {skin: default}\n", encoding="utf-8")
    await call("session.info", session_id=sid)
    assert counts == {"tools": 3, "availability": 3, "skills": 4}


# --- git branch for a cwd that is no repo -------------------------------------------------------------


def _inside_a_checkout(path) -> bool:
    for start in {os.path.abspath(path), os.path.realpath(path)}:
        current = start
        while True:
            if os.path.lexists(os.path.join(current, ".git")):
                return True
            parent = os.path.dirname(current)
            if parent == current:
                break
            current = parent
    return False


@pytest.fixture
def _no_git_env(monkeypatch):
    monkeypatch.delenv("GIT_DIR", raising=False)
    monkeypatch.delenv("GIT_WORK_TREE", raising=False)


def test_branch_spawns_no_git_outside_any_repo(tmp_path, monkeypatch, _no_git_env):
    if _inside_a_checkout(tmp_path):
        pytest.skip("the temp dir sits inside a git checkout")

    def no_git(cwd, *args):
        raise AssertionError(f"git spawned for {cwd} {args}")

    monkeypatch.setattr(git_probe, "run_git", no_git)
    assert git_probe.branch(str(tmp_path)) == ""
    assert git_probe.branch(str(tmp_path / "missing" / "dir")) == ""


@pytest.mark.parametrize("marker", ["git_dir", "git_file", "bare_repo"])
def test_branch_still_asks_git_wherever_a_repo_may_be(tmp_path, monkeypatch, _no_git_env, marker):
    repo = tmp_path / "repo"
    repo.mkdir()
    if marker == "git_dir":
        (repo / ".git").mkdir()
    elif marker == "git_file":  # a linked worktree or a submodule
        (repo / ".git").write_text("gitdir: ../elsewhere\n", encoding="utf-8")
    else:
        (repo / "objects").mkdir()
        (repo / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    nested = repo / "src" / "pkg"
    nested.mkdir(parents=True)
    calls = []
    monkeypatch.setattr(git_probe, "run_git", lambda cwd, *args: calls.append(args) or "main")
    assert git_probe.branch(str(nested)) == "main"
    assert calls == [("branch", "--show-current")]


def test_branch_follows_a_link_into_a_checkout(tmp_path, monkeypatch, _no_git_env):
    # git resolves the cwd it is handed: a symlink or junction into a checkout is in that repo, although
    # no parent of the link itself holds a .git.
    if _inside_a_checkout(tmp_path):
        pytest.skip("the temp dir sits inside a git checkout")
    target = tmp_path / "repo" / "src"
    target.mkdir(parents=True)
    (tmp_path / "repo" / ".git").mkdir()
    link = tmp_path / "outside" / "link"
    link.parent.mkdir()
    try:
        os.symlink(target, link, target_is_directory=True)
    except (OSError, NotImplementedError):
        if os.name != "nt":
            pytest.skip("cannot create a symlink here")
        import _winapi
        _winapi.CreateJunction(str(target), str(link))
    calls = []
    monkeypatch.setattr(git_probe, "run_git", lambda cwd, *args: calls.append(args) or "main")
    assert git_probe.branch(str(link)) == "main"
    assert calls == [("branch", "--show-current")]


def test_branch_leaves_a_git_dir_override_to_git(tmp_path, monkeypatch):
    monkeypatch.setenv("GIT_DIR", str(tmp_path / "elsewhere.git"))
    calls = []
    monkeypatch.setattr(git_probe, "run_git", lambda cwd, *args: calls.append(args) or "")
    assert git_probe.branch(str(tmp_path)) == ""
    assert calls == [("branch", "--show-current"), ("rev-parse", "--short", "HEAD")]


@pytest.mark.skipif(shutil.which("git") is None, reason="needs git")
def test_a_git_init_shows_on_the_next_call(tmp_path, _no_git_env):
    if _inside_a_checkout(tmp_path):
        pytest.skip("the temp dir sits inside a git checkout")
    work = tmp_path / "work"
    work.mkdir()
    assert git_probe.branch(str(work)) == ""
    subprocess.run(["git", "init", "-q", "-b", "fresh-branch", str(work)], check=True, timeout=30)
    assert git_probe.branch(str(work)) == "fresh-branch"
