"""반도체 종목군(월초 asof 동결) 조달 — T5-4 semi_diffusion 입력 (계획서 §3.3 semi_diffusion_z 행).

정의: 반도체 종목군(asof) = KOSPI200 PIT 구성(bronze constituents, asof) ∩ KRX 반도체 지수 PDF(asof).
- KRX 지수 소스(config `semi_diffusion.source.index_codes`, T5-4 실측 2026-08-17):
    5044 "KRX 반도체"         — 삼성전자가 2023-09 정기변경 전까지 미편입(지수 방법론), 종목군 정의(업종)와 어긋남
    5422 "KRX 반도체 Top 15"  — 삼성전자 전 구간 편입
  → 채택 = 두 지수 PDF의 **합집합** ∩ KOSPI200 PIT (각 종목이 어느 지수에서 왔는지 `source` 열에 기록).
  pykrx KOSPI 업종지수 목록(1001~1047)에는 "반도체" 업종이 없다(전기전자 1013 뿐) — 실측 기록.
- 시점: 월초 첫 거래일 asof(= constituents.parquet 의 asof)마다 그 날짜의 PDF → PIT. 생존 편향 없음(survivorship_bias=False).
- 실패(빈 PDF·세션): loud-failure PROCURE_FAIL:KRX_SESSION — 조용히 빈 종목군 저장 금지.

출력: silver/semi_group_monthly.parquet (SILVER_SEMI_GROUP_MONTHLY):
  month, asof, code, name, source("5044|5422" 등), in_k200(True 고정), survivorship_bias(False), fetch_ts
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Sequence

import pandas as pd
import pyarrow as pa

from mtpro import settings
from mtpro.ingest import krx, store

SOURCE_METHOD = "pykrx_index_pdf_union"
DEFAULT_INDEX_CODES: tuple[str, ...] = ("5044", "5422")
INDEX_NAMES = {"5044": "KRX 반도체", "5422": "KRX 반도체 Top 15"}
P_SEMI_GROUP = settings.SILVER / "semi_group_monthly.parquet"

SILVER_SEMI_GROUP_MONTHLY = pa.schema([
    ("month", pa.string()),
    ("asof", pa.date32()),
    ("code", pa.string()),
    ("name", pa.string()),
    ("source", pa.string()),            # 어느 KRX 지수 PDF에 있었는지 ("5044|5422")
    ("in_k200", pa.bool_()),            # KOSPI200 PIT 구성 ∩ (정의상 항상 True)
    ("survivorship_bias", pa.bool_()),  # PIT 조달 = False. 현재 리스트 소급 시 True 로 명시
    ("fetch_ts", pa.timestamp("s", tz="UTC")),
])


def fetch_semi_group_monthly(
    constituents: pd.DataFrame,
    index_codes: Sequence[str] = DEFAULT_INDEX_CODES,
    k200_index_code: str = krx.KOSPI200_INDEX_CODE,
) -> pd.DataFrame:
    """bronze constituents(asof, index_code, code) 의 asof 마다 KRX 지수 PDF(asof) ∩ KOSPI200 PIT.

    - 어느 지수 PDF 든 0 종목이면 PROCURE_FAIL:KRX_SESSION (세션 만료 시 pykrx 는 조용히 빈 리스트).
    - 교집합이 비면 그 asof 는 행 0 개 (지수는 있었으나 K200 겹침 없음) — 호출자가 loud 하게 다룬다.
    """
    st = krx._stock()
    cons = constituents.copy()
    if "index_code" in cons.columns:
        cons = cons[cons["index_code"].astype(str) == str(k200_index_code)]
    cons["asof"] = pd.to_datetime(cons["asof"]).dt.date
    cons["code"] = cons["code"].astype(str)
    asofs = sorted(cons["asof"].unique())
    if not asofs:
        raise krx._fail("CONSTITUENTS_MISSING", {"what": "semi_group: constituents empty"})
    names: dict[str, str] = {}
    rows: list[dict] = []
    ts = krx._now_utc()
    for asof in asofs:
        k200 = set(cons.loc[cons["asof"] == asof, "code"])
        found: dict[str, list[str]] = {}
        for ic in index_codes:
            lst = krx._call(st.get_index_portfolio_deposit_file, str(ic), krx._ymd(asof), what=f"pdf {ic} {asof}")
            if not len(lst):
                raise krx._fail("KRX_SESSION", {"what": f"semi_group pdf {ic} {asof}", "rows": 0,
                                                "session_alive": krx.session_alive()})
            for c in lst:
                c = str(c)
                if c in k200:
                    found.setdefault(c, []).append(str(ic))
        for c in sorted(found):
            if c not in names:
                try:
                    names[c] = str(krx._call(st.get_market_ticker_name, c, what=f"name {c}"))
                except krx.ProcureError:
                    names[c] = None
            rows.append({"month": f"{asof.year:04d}-{asof.month:02d}", "asof": asof, "code": c, "name": names[c],
                         "source": "|".join(found[c]), "in_k200": True, "survivorship_bias": False, "fetch_ts": ts})
    return pd.DataFrame(rows, columns=SILVER_SEMI_GROUP_MONTHLY.names)


def write_semi_group(df: pd.DataFrame, path: Path = P_SEMI_GROUP) -> int:
    return store.write(df, SILVER_SEMI_GROUP_MONTHLY, path)


def read_semi_group(path: Path = P_SEMI_GROUP) -> pd.DataFrame | None:
    return store.read(path)


def summarize_semi_group(df: pd.DataFrame) -> dict:
    g = df.groupby("asof")
    per = g["code"].apply(lambda s: sorted(s)).to_dict()
    n = g.size()
    return {
        "method": SOURCE_METHOD,
        "months": int(df["asof"].nunique()),
        "asof_range": [str(df["asof"].min()), str(df["asof"].max())] if len(df) else None,
        "n_per_month": {"min": int(n.min()), "median": float(n.median()), "max": int(n.max())} if len(n) else None,
        "codes_ever": sorted(df["code"].unique()),
        "names": {c: nm for c, nm in df.drop_duplicates("code")[["code", "name"]].itertuples(index=False)},
        "membership_by_asof": {str(k): v for k, v in per.items()},
        "survivorship_bias": bool(df["survivorship_bias"].any()) if len(df) else None,
    }
