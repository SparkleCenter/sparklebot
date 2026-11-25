"""Sparklebot: one ``GET /api/messaging/platforms`` reads the gateway config and liveness once.

Every platform row used to run its own ``load_gateway_config()`` (plus one for the relay label), so a
Channels page open did about thirty full gateway config loads and took 6-24 s. ``_platform_payloads``
now hands one request-local memo to every row. These pin the read counts, an unchanged response
(shared and per-row reads give the same JSON), the old per-row fallback when the shared load fails,
and that nothing carries over to the next request: a platform enabled in between shows on the next open.
"""
from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

_VALID_BOT_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_1234"
_ENABLED_TELEGRAM = "platforms:\n  telegram:\n    enabled: true\n"


@pytest.fixture
def client(monkeypatch, _isolate_hermes_home):
    from starlette.testclient import TestClient

    import hermes_constants
    import hermes_state
    from hermes_constants import get_hermes_home
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    home = get_hermes_home()
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", home / "state.db")
    monkeypatch.setattr(hermes_constants, "_default_hermes_root_memo", None)
    for var in ("TELEGRAM_BOT_TOKEN", "GATEWAY_RELAY_URL", "GATEWAY_RELAY_ALLOW_DIRECT_PLATFORMS",
                "GATEWAY_RELAY_PLATFORMS"):
        monkeypatch.delenv(var, raising=False)
    (home / ".env").write_text(f"TELEGRAM_BOT_TOKEN={_VALID_BOT_TOKEN}\n", encoding="utf-8")
    (home / "config.yaml").write_text(_ENABLED_TELEGRAM, encoding="utf-8")
    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


@pytest.fixture
def counts(monkeypatch):
    """Counts the real gateway config loads and liveness resolutions the route makes."""
    from gateway import config as gateway_config
    from hermes_cli.web_routers import messaging

    seen = {"load": 0, "liveness": 0}
    real_load, real_liveness = gateway_config.load_gateway_config, messaging.resolve_gateway_liveness

    def load(*args, **kwargs):
        seen["load"] += 1
        return real_load(*args, **kwargs)

    def liveness(*args, **kwargs):
        seen["liveness"] += 1
        return real_liveness(*args, **kwargs)

    monkeypatch.setattr(gateway_config, "load_gateway_config", load)
    monkeypatch.setattr(messaging, "resolve_gateway_liveness", liveness)
    return seen


def _per_row_reads(monkeypatch) -> None:
    """The behaviour before the memo: every caller computes its own value."""
    from hermes_cli.web_routers import messaging

    monkeypatch.setattr(messaging, "_request_memo", lambda memo, key, compute: compute())


def _platforms(client) -> dict[str, dict]:
    resp = client.get("/api/messaging/platforms")
    assert resp.status_code == 200, resp.text
    return {p["id"]: p for p in resp.json()["platforms"]}


def test_one_request_loads_the_gateway_config_once_whatever_the_row_count(client, counts, monkeypatch):
    rows = _platforms(client)
    assert len(rows) > 10  # the bundled catalog: one shared load serves all of these rows
    assert counts == {"load": 1, "liveness": 1}

    _platforms(client)  # the next request reads again: nothing is kept between requests
    assert counts == {"load": 2, "liveness": 2}

    _per_row_reads(monkeypatch)
    _platforms(client)
    assert counts["load"] - 2 == len(rows) + 1  # what it used to cost: one per row, plus the relay label


def test_a_named_bot_loads_no_gateway_config_and_keeps_its_own_state(client, counts):
    """The scoped arm (the other bots) reads only its own profile: still no gateway config load, one
    liveness check for all rows, and neither bot's verdict leaks into the other's response."""
    from hermes_cli import profiles as profiles_mod

    worker = profiles_mod.get_profile_dir("worker")
    worker.mkdir(parents=True)
    (worker / "config.yaml").write_text("platforms:\n  telegram:\n    enabled: false\n", encoding="utf-8")

    resp = client.get("/api/messaging/platforms?profile=worker")
    assert resp.status_code == 200, resp.text
    rows = {p["id"]: p for p in resp.json()["platforms"]}
    assert len(rows) > 10
    assert counts == {"load": 0, "liveness": 1}
    assert (rows["telegram"]["enabled"], rows["telegram"]["configured"]) == (False, False)

    default = _platforms(client)  # the default bot right after: its own config and .env
    assert (default["telegram"]["enabled"], default["telegram"]["configured"]) == (True, True)
    assert counts == {"load": 1, "liveness": 2}


@pytest.mark.parametrize("relay_url", [None, "https://relay.example.test"])
def test_shared_reads_leave_the_response_unchanged(client, monkeypatch, relay_url):
    if relay_url:
        monkeypatch.setenv("GATEWAY_RELAY_URL", relay_url)
        monkeypatch.setenv("GATEWAY_RELAY_PLATFORMS", "telegram,discord")

    shared = client.get("/api/messaging/platforms").json()
    _per_row_reads(monkeypatch)
    per_row = client.get("/api/messaging/platforms").json()

    assert shared == per_row
    telegram = next(p for p in shared["platforms"] if p["id"] == "telegram")
    assert telegram["configured"] is True
    assert telegram["enabled"] is (relay_url is None)
    assert telegram["disabled_by_relay"] is (relay_url is not None)


def test_a_failed_shared_load_gives_every_row_its_old_fallback(client, monkeypatch):
    from gateway import config as gateway_config

    attempts: list[int] = []

    def broken(*args, **kwargs):
        attempts.append(1)
        raise RuntimeError("gateway config unreadable")

    monkeypatch.setattr(gateway_config, "load_gateway_config", broken)
    shared = _platforms(client)
    assert len(attempts) == 1  # tried once, and the failure replays to every row

    telegram = shared["telegram"]
    assert (telegram["enabled"], telegram["configured"], telegram["state"]) == (False, True, "disabled")
    assert not any(row["disabled_by_relay"] for row in shared.values())

    _per_row_reads(monkeypatch)
    assert _platforms(client) == shared  # the same verdicts the per-row loads gave


def test_the_next_open_shows_a_platform_toggled_in_between(client):
    assert _platforms(client)["telegram"]["enabled"] is True

    resp = client.put("/api/messaging/platforms/telegram", json={"enabled": False})
    assert resp.status_code == 200, resp.text
    assert _platforms(client)["telegram"]["enabled"] is False

    resp = client.put("/api/messaging/platforms/telegram", json={"enabled": True})
    assert resp.status_code == 200, resp.text
    assert _platforms(client)["telegram"]["enabled"] is True


def test_the_next_open_shows_a_config_written_outside_the_dashboard(client):
    """A CLI or editor write has no hook to invalidate anything; there is nothing to invalidate."""
    from hermes_constants import get_hermes_home

    assert _platforms(client)["webhook"]["enabled"] is False
    (get_hermes_home() / "config.yaml").write_text(
        _ENABLED_TELEGRAM + "  webhook:\n    enabled: true\n", encoding="utf-8")
    assert _platforms(client)["webhook"]["enabled"] is True


def test_request_memo_computes_once_and_replays_the_same_failure():
    from hermes_cli.web_routers.messaging import _request_memo

    calls: list[int] = []

    def compute():
        calls.append(1)
        return len(calls)

    assert [_request_memo(None, "k", compute) for _ in range(3)] == [1, 2, 3]  # no memo: runs every time

    memo: dict = {}
    assert [_request_memo(memo, "k", compute) for _ in range(3)] == [4, 4, 4]
    assert len(calls) == 4

    def fail():
        calls.append(1)
        raise ValueError("boom")

    raised = []
    for _ in range(3):
        with pytest.raises(ValueError, match="boom") as info:
            _request_memo(memo, "bad", fail)
        raised.append(info.value)
    assert len(calls) == 5 and raised[0] is raised[1] is raised[2]
    assert len(memo) == 2  # one slot per key; the memo itself is dropped with its request
