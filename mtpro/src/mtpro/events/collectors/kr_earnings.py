"""삼성전자 잠정실적·SK하이닉스 실적 컨센서스 수집 — 네이버금융 종목분석 페이지(FnGuide 데이터).

실측 (2026-08-17):
- finance.naver.com/item/main.naver 의 '기업실적분석' 표는 최근 4분기 + (E) 1분기만 노출 → 이벤트 대상 분기(예: 2026/09)가 없을 수 있음.
- finance.naver.com/item/coinfo.naver?code=... (종목분석 탭)은 navercomp.wisereport.co.kr 를 iframe 으로 싣는다.
  그 안의 'Financial Highlight' 분기 표(ajax/cF1001.aspx, freq_typ=Q)에 2026/06(E)·2026/09(E)·2026/12(E) 컨센서스가 있고
  '영업이익(발표기준)' 행이 채워져 있다 (2026-08-17: 삼성전자 2026/09(E) = 1,139,748 억원). → HTTP 200, 파싱 성공.
  절차: (1) c1010001.aspx?cmp_cd=CODE GET → HTML 안의 encparam·id 추출 (2) ajax/cF1001.aspx GET (Referer 필수).
- 대상 분기 = 이벤트 현지일 직전 분기말(10월 이벤트 → 2026/09). 컬럼이 없거나 (E) 가 아닌 (A)면 CollectError (다른 분기 값 대체 금지).

값: '영업이익(발표기준)' 우선, 없으면 '영업이익'. 단위 억원 (표 단위).
"""
from __future__ import annotations

import re
from datetime import date, datetime, timezone
from typing import Any

import requests
from bs4 import BeautifulSoup

from mtpro.events.calendar import CalendarEvent
from mtpro.events.collectors import CollectError

WISE_BASE = "https://navercomp.wisereport.co.kr"
WISE_PAGE = WISE_BASE + "/v2/company/c1010001.aspx?cmp_cd={code}"
WISE_AJAX = WISE_BASE + "/v2/company/ajax/cF1001.aspx"
NAVER_COINFO = "https://finance.naver.com/item/coinfo.naver?code={code}"
UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
}
ROW_PREFERENCE = ("영업이익(발표기준)", "영업이익")
UNIT = "억원"


def target_quarter(local_date: date) -> str:
    """이벤트 현지일 직전 분기말 → 'YYYY/MM' (10/08 → '2026/09', 1월 → 전년 '/12')."""
    m = ((local_date.month - 1) // 3) * 3
    if m == 0:
        return f"{local_date.year - 1}/12"
    return f"{local_date.year}/{m:02d}"


def _to_number(s: str) -> float:
    t = (s or "").replace(",", "").replace("억원", "").strip()
    if t in ("", "-", "N/A", "n/a"):
        raise CollectError(f"empty cell {s!r}")
    try:
        return float(t)
    except ValueError as exc:
        raise CollectError(f"non-numeric cell {s!r}") from exc


def parse_quarter_table(html: str) -> tuple[list[str], dict[str, list[str]]]:
    """cF1001(freq_typ=Q) HTML → (컬럼 헤더 목록, {행이름: 셀 목록})."""
    soup = BeautifulSoup(html, "lxml")
    for t in soup.find_all("table"):
        rows = t.find_all("tr")
        header = None
        body: dict[str, list[str]] = {}
        for tr in rows:
            cells = [c.get_text(" ", strip=True) for c in tr.find_all(["th", "td"])]
            if not cells:
                continue
            if header is None and any(re.match(r"\d{4}/\d{2}", c) for c in cells):
                header = [re.sub(r"\s*\(IFRS.*?\)|\s*\(GAAP.*?\)", "", c).strip() for c in cells]
                continue
            if header is not None and len(cells) >= 2:
                body[cells[0]] = cells[1:]
        if header and body:
            return header, body
    raise CollectError("quarter table not found in cF1001 response (structure changed?)")


def fetch_quarter_table(code: str, session: requests.Session | None = None, timeout: int = 20) -> tuple[str, str]:
    """(page_url, ajax_html)."""
    s = session or requests.Session()
    page = WISE_PAGE.format(code=code)
    r = s.get(page, headers={**UA, "Referer": NAVER_COINFO.format(code=code)}, timeout=timeout)
    if r.status_code != 200:
        raise CollectError(f"wisereport page HTTP {r.status_code}")
    m = re.search(r"encparam[\"']?\s*[:=]\s*[\"']([^\"']+)", r.text)
    if not m:
        raise CollectError("encparam not found in wisereport page (structure changed?)")
    enc = m.group(1)
    idm = re.search(r"id:\s*'([^']+)'\s*\?", r.text)
    params = {"cmp_cd": code, "fin_typ": 0, "freq_typ": "Q", "extY": 0, "extQ": 0, "encparam": enc,
              "id": idm.group(1) if idm else ""}
    a = s.get(WISE_AJAX, params=params, headers={**UA, "Referer": page}, timeout=timeout)
    if a.status_code != 200:
        raise CollectError(f"wisereport cF1001 HTTP {a.status_code}")
    return page, a.text


def extract_consensus(header: list[str], body: dict[str, list[str]], quarter: str) -> tuple[float, str, str]:
    """(value, row_name, column_label). 대상 분기 컬럼이 (E) 여야 함."""
    col = None
    for i, h in enumerate(header):
        if h.startswith(quarter):
            col = (i, h)
            break
    if col is None:
        raise CollectError(f"target quarter {quarter} not in columns {header}")
    idx, label = col
    if "(E)" not in label:
        raise CollectError(f"target quarter column {label!r} is not an estimate (E) — consensus unavailable")
    for name in ROW_PREFERENCE:
        cells = body.get(name)
        if cells is None or idx >= len(cells):
            continue
        try:
            return _to_number(cells[idx]), name, label
        except CollectError:
            continue
    raise CollectError(f"no 영업이익 value for {label} (rows tried {ROW_PREFERENCE})")


def collect(event: CalendarEvent, *, now: datetime | None = None, session=None) -> dict[str, Any]:
    if event.event_type not in ("SEC_PRELIM", "HYNIX_EARN"):
        raise CollectError(f"{event.event_id}: kr_earnings collector does not handle {event.event_type}")
    code = event.spec.ticker if event.spec and event.spec.ticker else None
    if not code:
        raise CollectError(f"{event.event_id}: no ticker in calendar spec")
    quarter = target_quarter(event.local_date)
    try:
        page_url, html = fetch_quarter_table(code, session)
    except requests.RequestException as exc:
        raise CollectError(f"{event.event_id}: request error {exc}") from exc
    header, body = parse_quarter_table(html)
    value, row_name, label = extract_consensus(header, body, quarter)
    return {
        "value": value, "unit": UNIT, "source": "naver_wisereport_fnguide", "source_url": page_url,
        "fetched_at": now or datetime.now(timezone.utc),
        "raw": {"row": row_name, "column": label, "quarter": quarter, "naver_page": NAVER_COINFO.format(code=code)},
    }
