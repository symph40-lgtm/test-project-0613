"""MT-PRO 설정·경로. .env는 mtpro/.env 하나만 읽는다 (기존 라이브 시스템 env·토큰 캐시와 완전 분리 — 발주자 지시 8/17 ②).

- ROOT = 저장소 루트 (이 파일 기준 상위 2단계)
- 토큰 캐시: ROOT/.cache/kis_token.json (git 무시)
- 데이터: ROOT/data/{bronze,silver,gold} (git 무시)
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = ROOT / ".env"
CACHE_DIR = ROOT / ".cache"
DATA_DIR = ROOT / "data"
BRONZE = DATA_DIR / "bronze"
SILVER = DATA_DIR / "silver"
GOLD = DATA_DIR / "gold"
CONFIG_DIR = ROOT / "config"
LOG_DIR = ROOT / "logs"

KIS_TOKEN_CACHE = CACHE_DIR / "kis_token.json"
KIS_BASE_REAL = "https://openapi.koreainvestment.com:9443"
KIS_BASE_PAPER = "https://openapivts.koreainvestment.com:29443"


class ConfigError(RuntimeError):
    """loud-failure: 설정 결손은 조용히 넘어가지 않는다."""


def env() -> dict[str, str]:
    """mtpro/.env만 읽는다. 프로세스 환경변수는 **읽지 않는다** — 다른 시스템의 KIS_* 가 새는 것을 막기 위함.
    단, MTPRO_ 접두 변수는 프로세스 환경에서도 허용(크론 주입용)."""
    vals = {k: v for k, v in dotenv_values(ENV_FILE).items() if v is not None} if ENV_FILE.exists() else {}
    for k, v in os.environ.items():
        if k.startswith("MTPRO_"):
            vals[k] = v
    return vals


def require(keys: list[str]) -> dict[str, str]:
    e = env()
    missing = [k for k in keys if not e.get(k)]
    if missing:
        raise ConfigError(f"PROCURE_FAIL:ENV_MISSING {missing} (expected in {ENV_FILE})")
    return {k: e[k] for k in keys}


def kis_base() -> str:
    mode = env().get("KIS_ENV", "real").lower()
    if mode not in ("real", "paper"):
        raise ConfigError(f"KIS_ENV must be real|paper, got {mode!r}")
    return KIS_BASE_REAL if mode == "real" else KIS_BASE_PAPER


def ensure_dirs() -> None:
    for p in (CACHE_DIR, BRONZE, SILVER, GOLD, LOG_DIR):
        p.mkdir(parents=True, exist_ok=True)
