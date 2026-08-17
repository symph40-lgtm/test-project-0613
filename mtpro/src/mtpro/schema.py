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

# T5-1 (계획서 §2.1·§12.5): 이벤트 일정 상태 — confirmed(공식 확인) | unconfirmed(미확인 추정) | tentative(공식 일정 미게시·예시)
EVENT_STATUSES = ("confirmed", "unconfirmed", "tentative")
# T5-1 (계획서 §2.1): 비독립 사유 enum. PSA_PENDING_SHOCK(T5-3)·DATA_GAP(T5-6)은 정의만 (T5-1 미적용).
CONTAMINATION_REASONS = ("OVERLAP_DIGEST_WINDOW", "SAME_DAY_MULTI", "EARNINGS_CLUSTER", "PSA_PENDING_SHOCK", "DATA_GAP")

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
    # ---- T5-1 이벤트 독립성·purge (AM-9, 계획서 §2.1) — 파생 필드, 동결 대상 아님 ----
    ("status", pa.string()),                                                      # EVENT_STATUSES (캘린더 status 전달)
    ("t0_kr", pa.date32()),                                                       # KR 거래일 09:00 (XKRX 동적 매핑 §12.5)
    ("digest_window_end", pa.date32()),                                           # t0_kr + (W_digest−1) 세션
    ("independence_flag", pa.bool_()),                                            # None = 미계산
    ("overlap_group", pa.string()),                                               # 원인 이벤트 id(체인 상속) / 같은 날 id 결합
    ("contamination_reason", pa.string()),                                        # CONTAMINATION_REASONS ';' 결합
    ("verify_eligible", pa.bool_()),                                              # independence ∧ grade A ∧ 결측 없음 ∧ ≠tentative
])

# T5-1: silver/events_kr.parquet (jobs/build_events_kr.py) — 레지스트리 ∪ 캘린더 이벤트의 t0·독립성 파생 테이블
SILVER_EVENTS_KR = pa.schema([
    ("event_id", pa.string()), ("event_type", pa.string()),
    ("scheduled_ts_utc", pa.timestamp("s", tz="UTC")), ("t0_mode", pa.string()),
    ("status", pa.string()), ("grade", pa.string()),
    ("t0_kr", pa.date32()), ("digest_window_end", pa.date32()),
    ("independence_flag", pa.bool_()), ("overlap_group", pa.string()), ("contamination_reason", pa.string()),
    ("verify_eligible", pa.bool_()),
    ("row_source", pa.string()),                                                  # registry | calendar
    ("calendar_source", pa.string()),                                             # exchange_calendars:XKRX | fallback:*
    ("engine_ver", pa.string()),
])

SILVER_CONSTITUENTS_MONTHLY = pa.schema([
    ("month", pa.string()), ("asof", pa.date32()), ("code", pa.string()),
    ("mcap_rank", pa.int32()), ("tier", pa.string()),   # large 1~50 | mid 51~150 | small 151~200 (사전 등록)
])

# ---- gold (부품 입력) — 컬럼은 T3에서 채움, 여기선 공통 메타만 고정 --------
GOLD_COMMON_META = [("date", pa.date32()), ("scope", pa.string()), ("engine_ver", pa.string()),
                    ("missing", pa.list_(pa.string()))]   # 결측 컴포넌트 이름 목록 (None 유지 근거)


GOLD_FLOW_PANEL = pa.schema([                       # 부품 4 Flow Impact (T3-A) — 결측은 None 유지
    ("date", pa.date32()), ("scope", pa.string()),
    ("foreign_norm", pa.float64()), ("institution_norm", pa.float64()),           # net / mean20(비수정 거래대금)
    ("flow_beta_foreign", pa.float64()), ("flow_beta_inst", pa.float64()),          # 120일 OLS(과거만, t 포함), n<60 → None
    ("expected_from_flow", pa.float64()), ("flow_impact_residual_z", pa.float64()),
    ("flow_trend_z", pa.float64()),                                                 # 5일 foreign_norm 기울기의 과거 120일 대비 z
    ("n_beta_obs", pa.int32()), ("beta_extreme_flag", pa.bool_()),                  # |β|>1 (T1 검증 항목)
    ("engine_ver", pa.string()),
])


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
