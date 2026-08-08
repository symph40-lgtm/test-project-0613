# T3 — align 테스트 (WORKORDER §4.2, 코드보다 먼저 작성)
# map_nights는 캘린더(XKRX/XNYS)만 쓰므로 네트워크 불필요 — 전 케이스 오프라인 실행.
import pandas as pd
import pytest

from src.align import LookaheadError, map_nights, _assert_no_lookahead


def nights(start: str, end: str) -> pd.DataFrame:
    return map_nights(start, end)


# 1. 평상 밤: 미 화요일 세션 → KRX 수요일 시가
def test_normal_night():
    df = nights("2024-06-01", "2024-06-14")
    row = df[df["krx_date"] == "2024-06-05"]
    assert len(row) == 1
    r = row.iloc[0]
    assert r["us_dates"] == ["2024-06-04"]
    assert not r["multi_session"]
    assert r["n_us_sessions"] == 1


# 2. 미 휴장(추수감사절 2023-11-23 목)·KRX 개장 → 표본 제외 + us_holiday_skip 기록
def test_us_holiday_krx_open():
    df = nights("2023-11-20", "2023-11-30")
    row = df[df["krx_date"] == "2023-11-24"]
    assert len(row) == 1
    r = row.iloc[0]
    assert r["us_holiday_skip"]
    assert r["n_us_sessions"] == 0
    assert r["excluded"]


# 3. KRX 연휴(2024 설: 2/9 금~2/12 월 휴장)·미 개장 → 미국 다중 세션 누적
def test_krx_holiday_multi_session():
    df = nights("2024-02-05", "2024-02-16")
    row = df[df["krx_date"] == "2024-02-13"]
    assert len(row) == 1
    r = row.iloc[0]
    assert r["multi_session"]
    assert r["us_dates"] == ["2024-02-08", "2024-02-09", "2024-02-12"]
    assert r["n_us_sessions"] == 3
    assert r["exclude_from_base_regression"]  # 기본 회귀 제외 플래그 (스펙 §2.3-1)


# 4. 미 반일장(추수감사절 익일 금 13:00 ET 마감) → 정상 포함 + 플래그
def test_us_half_day_included():
    df = nights("2023-11-20", "2023-11-30")
    row = df[df["krx_date"] == "2023-11-27"]  # 미 11/24(반일) → KRX 11/27(월)
    assert len(row) == 1
    r = row.iloc[0]
    assert not r["excluded"]
    assert "2023-11-24" in r["us_dates"]
    assert r["us_half_day"]


# 5. 서머타임 전환 주간 — 3월·11월 각 1주 빌드 시 assert 통과 (예외 없이 완주)
def test_dst_transition_weeks():
    spring = nights("2024-03-08", "2024-03-15")  # 2024-03-10 US DST 시작
    fall = nights("2024-11-01", "2024-11-08")    # 2024-11-03 US DST 종료
    assert len(spring) > 0 and len(fall) > 0
    # 전환 주간에도 모든 밤의 시각 순서가 지켜져야 한다 (map_nights 내부에서 전수 assert 수행됨)


# 6. 룩어헤드 주입: 고의로 잘못된 타임스탬프 → 예외 발생 (경고 강등 금지 — WORKORDER §0-3)
def test_lookahead_injection_raises():
    pairs = pd.DataFrame({
        "us_close_utc": [pd.Timestamp("2024-06-05 09:30", tz="UTC")],  # KRX 개장(00:00 UTC) 이후
        "krx_open_utc": [pd.Timestamp("2024-06-05 00:00", tz="UTC")],
        "us_dates": [["2024-06-04"]], "krx_date": ["2024-06-05"],
    })
    with pytest.raises(LookaheadError):
        _assert_no_lookahead(pairs)


# 7. 금요일 밤 → KRX 월요일 매핑
def test_friday_to_monday():
    df = nights("2024-06-03", "2024-06-14")
    row = df[df["krx_date"] == "2024-06-10"]  # 월요일
    assert len(row) == 1
    assert row.iloc[0]["us_dates"] == ["2024-06-07"]  # 금요일 미 세션


# 보강: 전 행 타임스탬프 순서 — 샘플 구간에서 명시 재검증
def test_all_rows_ordered():
    df = nights("2023-01-01", "2024-12-31")
    live = df[~df["excluded"]]
    assert (live["us_close_utc"] < live["krx_open_utc"]).all()
