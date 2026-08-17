"""MT-PRO 데이터 계층 스키마 (bronze/silver/gold, parquet). 사전 등록 조건 C-2·C-3 반영.

C-2: 모든 가격·거래대금 시계열에 `price_adjusted: bool` 필수. 가격 지표(MA·신고저·수익률)는 adjusted=True 원천,
     거래대금·시총 분모는 adjusted=False 원천. 서로 다른 price_adjusted 값의 가격 컬럼을 한 식에 넣으면 assert.
C-3: 이벤트 행에 `t0_mode ∈ {"A1_open","release_time"}` 필수. 국내 자산 이벤트는 전부 A1_open(발주자 8/17),
     release_time은 SOXX(미국 자산) 이벤트 전용. 채점·통계는 t0_mode별 분리.
결측은 None/NaN 그대로 (0 대체 금지, 불변 규칙 3).
"""
from __future__ import annotations

import pyarrow as pa

T0_MODES = ("A1_open", "release_time")
EVENT_TYPES = ("FOMC", "US_CPI", "US_NFP", "US_PCE", "SEC_PRELIM", "HYNIX_EARN", "NVDA_EARN")
ASSET_SCOPES = ("KOSPI200", "005930", "000660", "SOXX")
GRADES = ("A", "C")

# ---- bronze (원본 그대로 + 조달 메타) --------------------------------------
BRONZE_INVESTOR_FLOW = pa.schema([
    ("date", pa.date32()), ("scope", pa.string()),            # 005930 | 000660 | KOSPI (시장 전체) | KOSDAQ
    ("institution", pa.float64()), ("other_corp", pa.float64()), ("individual", pa.float64()),
    ("foreign", pa.float64()), ("total", pa.float64()),
    ("unit", pa.string()),                                      # KRW
    ("source", pa.string()), ("fetch_ts", pa.timestamp("s", tz="UTC")),
    ("krx_session", pa.bool_()),                                # 로그인 세션에서 조달했는가 (T1-1 loud-failure 근거)
])

BRONZE_OHLCV = pa.schema([
    ("date", pa.date32()), ("code", pa.string()),
    ("open", pa.float64()), ("high", pa.float64()), ("low", pa.float64()), ("close", pa.float64()),
    ("volume", pa.float64()), ("trading_value", pa.float64()),  # trading_value는 비수정 원천에만 존재
    ("price_adjusted", pa.bool_()),                             # C-2 필수
    ("source", pa.string()), ("fetch_ts", pa.timestamp("s", tz="UTC")),
])

BRONZE_MARKET_CAP = pa.schema([
    ("asof", pa.date32()), ("code", pa.string()), ("close", pa.float64()), ("market_cap", pa.float64()),
    ("trading_value", pa.float64()), ("shares", pa.float64()), ("price_adjusted", pa.bool_()),  # 항상 False
    ("source", pa.string()), ("fetch_ts", pa.timestamp("s", tz="UTC")),
])

BRONZE_CONSTITUENTS = pa.schema([
    ("asof", pa.date32()), ("index_code", pa.string()), ("code", pa.string()),
    ("source", pa.string()), ("fetch_ts", pa.timestamp("s", tz="UTC")),
])

BRONZE_MINUTE = pa.schema([
    ("date", pa.date32()), ("code", pa.string()), ("time", pa.string()),   # HH:MM 봉 시작
    ("open", pa.float64()), ("high", pa.float64()), ("low", pa.float64()), ("close", pa.float64()),
    ("volume", pa.float64()), ("price_adjusted", pa.bool_()),               # 분봉은 비수정(False)
    ("market_div", pa.string()),                                            # J 정규장 | NX 프리 | ...
    ("source", pa.string()), ("fetch_ts", pa.timestamp("s", tz="UTC")),
])

# ---- silver (정렬·검증) -----------------------------------------------------
SILVER_CONSENSUS_REGISTRY = pa.schema([
    ("event_id", pa.string()), ("event_type", pa.string()), ("asset_scope", pa.list_(pa.string())),
    ("scheduled_ts_utc", pa.timestamp("s", tz="UTC")), ("t0_mode", pa.string()),      # C-3 필수
    ("consensus_value", pa.float64()), ("consensus_unit", pa.string()),
    ("vintage_ts", pa.timestamp("s", tz="UTC")), ("source", pa.string()), ("entered_by", pa.string()),
    ("frozen", pa.bool_()), ("frozen_ts", pa.timestamp("s", tz="UTC")), ("grade", pa.string()),
    ("actual_value", pa.float64()), ("actual_ts", pa.timestamp("s", tz="UTC")),
    ("available_at", pa.timestamp("s", tz="UTC")), ("supersedes", pa.string()), ("note", pa.string()),
    ("single_fetch", pa.bool_()),                                                 # 운영 결정 ①: D-1 단독 수집 표기
    ("manual_override", pa.bool_()),                                              # AM-4: 수동 입력이 자동을 이김
    ("auto_shadow_value", pa.float64()), ("auto_shadow_vintage_ts", pa.timestamp("s", tz="UTC")),
    ("auto_shadow_source", pa.string()),                                          # AM-4: 자동값 기록만 보존
])

SILVER_CONSTITUENTS_MONTHLY = pa.schema([
    ("month", pa.string()), ("asof", pa.date32()), ("code", pa.string()),
    ("mcap_rank", pa.int32()), ("tier", pa.string()),   # large 1~50 | mid 51~150 | small 151~200 (사전 등록)
])

# ---- gold (부품 입력) — 컬럼은 T3에서 채움, 여기선 공통 메타만 고정 --------
GOLD_COMMON_META = [("date", pa.date32()), ("scope", pa.string()), ("engine_ver", pa.string()),
                    ("missing", pa.list_(pa.string()))]   # 결측 컴포넌트 이름 목록 (None 유지 근거)


def assert_same_adjustment(*price_adjusted_flags: bool) -> None:
    """C-2: 서로 다른 수정 여부의 가격 컬럼을 한 식에 넣는 것을 금지."""
    if len(set(price_adjusted_flags)) > 1:
        raise AssertionError(f"C-2 violation: mixing adjusted/unadjusted prices {price_adjusted_flags}")


def assert_t0_mode(mode: str, asset_scope: str) -> None:
    """C-3 + 발주자 8/17: 국내 자산은 A1_open만, release_time은 SOXX 전용."""
    if mode not in T0_MODES:
        raise AssertionError(f"t0_mode must be one of {T0_MODES}, got {mode!r}")
    if asset_scope in ("KOSPI200", "005930", "000660") and mode != "A1_open":
        raise AssertionError(f"domestic scope {asset_scope} must use A1_open (got {mode})")
    if asset_scope == "SOXX" and mode != "release_time":
        raise AssertionError("SOXX events use release_time")
