"""T5-6 라이브 크론 진입점 (jobs/live_daily.py) — 드라이런·가짜 step 실행·실패 loud_failure·종료코드·로그 파일."""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]


def _load():
    spec = importlib.util.spec_from_file_location("live_daily", ROOT / "jobs" / "live_daily.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def test_steps_match_config_and_dry_run(capsys):
    ld = _load()
    cfg = yaml.safe_load((ROOT / "config" / "mtpro.yaml").read_text(encoding="utf-8"))
    assert list(cfg["live"]["steps"]) == ld.STEP_NAMES
    for name, argv, _ in ld.STEPS:
        if argv[1].endswith(".py"):
            assert Path(argv[1]).exists() or name == "build_mt_state", name        # build_mt_state 는 T5-5 산출(있으면 실행)
    assert ld.main(["--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "consensus_scheduler" in out and "build_absorption" in out
    assert ld.main(["--dry-run", "--only", "nope"]) == 2


def test_run_fake_steps_and_failure_is_loud(tmp_path, monkeypatch):
    ld = _load()
    monkeypatch.setattr(ld.settings, "LOG_DIR", tmp_path)
    seen = []
    monkeypatch.setattr(ld.alerts, "loud_failure", lambda kind, detail, **kw: seen.append((kind, detail)) or {})
    py = sys.executable
    monkeypatch.setattr(ld, "STEPS", [
        ("ok1", [py, "-c", "print('hello ok1')"], False),
        ("bad", [py, "-c", "import sys; print('x'); sys.exit(4)"], False),
        ("opt_missing", [py, str(tmp_path / "nope.py")], True),
        ("ok2", [py, "-c", "print('hello ok2')"], False),
    ])
    monkeypatch.setattr(ld, "STEP_NAMES", [s[0] for s in ld.STEPS])
    rc = ld.main(["--date", "2026-08-17"])
    assert rc == 1
    assert [k for k, _ in seen] == [ld.LIVE_STEP_FAIL] and seen[0][1]["step"] == "bad" and seen[0][1]["rc"] == 4
    log = (tmp_path / "live_daily_2026-08-17.log").read_text(encoding="utf-8")
    assert "hello ok1" in log and "hello ok2" in log and "rc=4" in log and "skipped" in log
    summ = json.loads((tmp_path / "live_daily_2026-08-17.json").read_text(encoding="utf-8"))
    assert summ["exit_code"] == 1 and summ["failed_steps"] == ["bad"]
    assert [s["name"] for s in summ["steps"]] == ["ok1", "bad", "opt_missing", "ok2"]
    assert summ["steps"][2]["rc"] is None
    # stop-on-fail: bad 이후 중단
    seen.clear()
    rc2 = ld.main(["--date", "2026-08-18", "--stop-on-fail"])
    summ2 = json.loads((tmp_path / "live_daily_2026-08-18.json").read_text(encoding="utf-8"))
    assert rc2 == 1 and [s["name"] for s in summ2["steps"]] == ["ok1", "bad"]
    # --only / --skip
    rc3 = ld.main(["--date", "2026-08-19", "--only", "ok1,ok2"])
    summ3 = json.loads((tmp_path / "live_daily_2026-08-19.json").read_text(encoding="utf-8"))
    assert rc3 == 0 and [s["name"] for s in summ3["steps"]] == ["ok1", "ok2"]


def test_step_timeout(tmp_path, monkeypatch):
    ld = _load()
    monkeypatch.setattr(ld.settings, "LOG_DIR", tmp_path)
    monkeypatch.setattr(ld.alerts, "loud_failure", lambda kind, detail, **kw: {})
    monkeypatch.setattr(ld, "STEPS", [("slow", [sys.executable, "-c", "import time; time.sleep(5)"], False)])
    monkeypatch.setattr(ld, "STEP_NAMES", ["slow"])
    rc = ld.main(["--date", "2026-08-20", "--step-timeout", "1"])
    summ = json.loads((tmp_path / "live_daily_2026-08-20.json").read_text(encoding="utf-8"))
    assert rc == 1 and summ["steps"][0]["rc"] == 124
