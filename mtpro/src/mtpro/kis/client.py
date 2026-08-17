"""KIS OpenAPI 클라이언트 (MT-PRO 전용 앱키). 토큰 캐시는 mtpro/.cache/kis_token.json **한 곳**.

규약 (발주자 지시 8/17):
- 앱키/시크릿은 mtpro/.env에서만 읽는다 (settings.env). 기존 시스템 env·토큰 캐시 접근 금지.
- 토큰 발급은 캐시 만료(만료 5분 전) 시에만. KIS는 재발급 시 이전 토큰을 폐기하므로 발급 남발 금지 —
  같은 앱키를 다른 프로세스가 쓰면 서로 무효화한다. 이 앱키는 mtpro 프로세스만 쓴다.
- 401/403 → 캐시 폐기 후 1회 재발급 재시도, 그래도 실패면 KisAuthError (loud-failure).
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import requests

from mtpro import settings

KST = timezone(timedelta(hours=9))


class KisError(RuntimeError):
    pass


class KisAuthError(KisError):
    pass


@dataclass
class Token:
    access_token: str
    expires_at: float  # epoch seconds
    issued_at: str

    def valid(self, margin_sec: int = 300) -> bool:
        return time.time() < self.expires_at - margin_sec


class KisClient:
    def __init__(self, timeout: float = 15.0):
        cfg = settings.require(["KIS_APP_KEY", "KIS_APP_SECRET"])
        self.appkey = cfg["KIS_APP_KEY"]
        self.appsecret = cfg["KIS_APP_SECRET"]
        self.base = settings.kis_base()
        self.timeout = timeout
        self._token: Token | None = self._load_cache()

    # ---- token cache -------------------------------------------------
    def _load_cache(self) -> Token | None:
        p = settings.KIS_TOKEN_CACHE
        if not p.exists():
            return None
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            # 앱키가 바뀌면(다른 키) 캐시 무효 — 키 자체는 저장하지 않고 앞 6자만 지문으로
            if d.get("appkey_fp") != self.appkey[:6]:
                return None
            return Token(d["access_token"], float(d["expires_at"]), d.get("issued_at", ""))
        except Exception:
            return None

    def _save_cache(self, t: Token) -> None:
        settings.ensure_dirs()
        settings.KIS_TOKEN_CACHE.write_text(
            json.dumps({"access_token": t.access_token, "expires_at": t.expires_at, "issued_at": t.issued_at,
                        "appkey_fp": self.appkey[:6], "base": self.base}),
            encoding="utf-8",
        )

    def _issue(self) -> Token:
        r = requests.post(
            f"{self.base}/oauth2/tokenP",
            json={"grant_type": "client_credentials", "appkey": self.appkey, "appsecret": self.appsecret},
            timeout=self.timeout,
        )
        if r.status_code != 200:
            raise KisAuthError(f"token issue failed {r.status_code}: {r.text[:200]}")
        j = r.json()
        tok = j.get("access_token")
        if not tok:
            raise KisAuthError(f"token issue: no access_token in response {str(j)[:200]}")
        expires_in = float(j.get("expires_in") or 86400)
        t = Token(tok, time.time() + expires_in, datetime.now(KST).isoformat(timespec="seconds"))
        self._save_cache(t)
        self._token = t
        return t

    def token(self) -> str:
        if self._token and self._token.valid():
            return self._token.access_token
        return self._issue().access_token

    def invalidate(self) -> None:
        self._token = None
        try:
            settings.KIS_TOKEN_CACHE.unlink()
        except FileNotFoundError:
            pass

    # ---- generic GET ---------------------------------------------------
    def get(self, path: str, tr_id: str, params: dict[str, Any], _retry: bool = True) -> dict[str, Any]:
        headers = {
            "authorization": f"Bearer {self.token()}",
            "appkey": self.appkey,
            "appsecret": self.appsecret,
            "tr_id": tr_id,
            "custtype": "P",
        }
        r = requests.get(f"{self.base}{path}", headers=headers, params=params, timeout=self.timeout)
        if r.status_code in (401, 403):
            if _retry:
                self.invalidate()
                return self.get(path, tr_id, params, _retry=False)
            raise KisAuthError(f"{r.status_code} after re-issue: {r.text[:200]}")
        if r.status_code != 200:
            raise KisError(f"{path} {r.status_code}: {r.text[:200]}")
        j = r.json()
        if str(j.get("rt_cd")) != "0":
            raise KisError(f"{path} rt_cd={j.get('rt_cd')} msg={j.get('msg1')}")
        return j
