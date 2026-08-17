"""parquet 저장 헬퍼 — pyarrow 스키마 강제(schema.py BRONZE_*), 증분 append(키 중복은 최신 우선).

- write(df, schema, path): 스키마로 캐스팅해 통째로 저장 (원자적: tmp → replace)
- append(df, schema, path, keys): 기존 + 신규를 키 기준 dedupe(신규 우선) 후 저장. 반환 = 최종 행 수
- read(path): 없으면 None
- last_date(df, key_col, key, date_col): 증분 시작점 계산용
결측은 None/NaN 그대로 (0 대체 금지).
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq


def to_table(df: pd.DataFrame, schema: pa.Schema) -> pa.Table:
    """DataFrame → 스키마 순서·타입으로 캐스팅. 스키마에 없는 열은 버리고, 없는 열은 None으로 채운다."""
    cols = {}
    for f in schema:
        if f.name in df.columns:
            s = df[f.name]
        else:
            s = pd.Series([None] * len(df), index=df.index, dtype="object")
        if pa.types.is_date32(f.type):
            s = pd.to_datetime(s).dt.date if len(s) else s
        elif pa.types.is_timestamp(f.type):
            s = pd.to_datetime(s, utc=True).dt.floor("s") if len(s) else s
        elif pa.types.is_floating(f.type):
            s = pd.to_numeric(s, errors="coerce").astype("float64")
        elif pa.types.is_boolean(f.type):
            s = s.astype("boolean")
        elif pa.types.is_integer(f.type):
            s = pd.to_numeric(s, errors="coerce").astype("Int64")
        elif pa.types.is_string(f.type):
            s = s.astype("object").where(s.notna(), None)
        cols[f.name] = s.reset_index(drop=True)
    out = pd.DataFrame(cols)
    return pa.Table.from_pandas(out, schema=schema, preserve_index=False)


def schema_matches(actual: pa.Schema, expected: pa.Schema) -> bool:
    """parquet 는 timestamp[s] 를 ms 로 저장하므로 단위 차이는 무시하고 이름·타입 순서를 비교한다."""
    if actual.names != expected.names:
        return False
    for a, e in zip(actual, expected):
        if pa.types.is_timestamp(a.type) and pa.types.is_timestamp(e.type):
            if a.type.tz != e.type.tz:
                return False
            continue
        if not a.type.equals(e.type):
            return False
    return True


def write(df: pd.DataFrame, schema: pa.Schema, path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    tbl = to_table(df, schema)
    tmp = path.with_suffix(path.suffix + ".tmp")
    pq.write_table(tbl, tmp)
    tmp.replace(path)
    return tbl.num_rows


def read(path: Path) -> pd.DataFrame | None:
    if not path.exists():
        return None
    return pq.read_table(path).to_pandas()


def append(df_new: pd.DataFrame, schema: pa.Schema, path: Path, keys: list[str]) -> int:
    """기존 파일과 합쳐 keys 기준 중복 제거(신규 우선) 후 저장. 반환: 최종 행 수."""
    old = read(path)
    if old is not None and len(old):
        new_t = to_table(df_new, schema).to_pandas() if len(df_new) else None
        merged = pd.concat([old, new_t], ignore_index=True) if new_t is not None else old
    else:
        merged = to_table(df_new, schema).to_pandas()
    if len(merged):
        merged = merged.drop_duplicates(subset=keys, keep="last")
        merged = merged.sort_values(keys).reset_index(drop=True)
    return write(merged, schema, path)


def last_date(df: pd.DataFrame | None, date_col: str, key_col: str | None = None, key: str | None = None) -> dt.date | None:
    if df is None or not len(df):
        return None
    sub = df if key_col is None else df[df[key_col] == key]
    if not len(sub):
        return None
    return pd.to_datetime(sub[date_col]).max().date()
