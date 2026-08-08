# WORK ORDER — G1B-R 구현 1주차: 데이터 조달 판정 + align.py

- 발주 문서 버전: v1.0
- 대상: Claude Code (작업 디렉토리: `g1br/`)
- 상위 스펙 (레포에 `specs/`로 복사해둘 것, 본 작업의 유일한 요구사항 원천):
  - `SPEC_G1B_R_beta_estimation.md` v0.2 (주 참조 — §2 데이터, §3 파이프라인, §4 구조)
  - `SPEC_G1B_gap_translation.md` v0.3 (채널 정의 참조)
  - `SPEC_G1_OPT_loop.md` v0.2 (§4 일간 학습 — 이번 주 구현 범위 아님, 인터페이스 예약만)
- **1주차 목표는 두 개뿐이다**: ① 데이터 조달 판정 완료 (AUDIT.md), ② align.py 완성 (테스트 통과).
  모델링은 배관 확인용 스모크 테스트 1개를 넘지 않는다.

---

## 0. 작업 규칙 (전 기간 적용)

1. **스펙 수정 금지.** 스펙과 현실이 충돌하면 코드를 스펙에 맞추지 말고 `WEEK1_REPORT.md`의
   "스펙 충돌" 절에 기록하고 진행 가능한 범위만 구현한다. 스펙 개정은 발주자 권한.
2. **결정적(deterministic) 실행.** 난수 시드 고정, 정렬 순서 명시. 같은 입력 → 같은 출력.
3. **룩어헤드는 버그가 아니라 사고다.** 시간 정렬 관련 assert 실패 시 우회하지 말고 중단·보고.
4. 모든 데이터 조달 시도는 성공/실패 무관 `AUDIT.md`에 기록 (소스, 기간, 결측률, 지연, 비고).
5. 커밋 단위: 태스크당 1커밋 이상, 메시지에 태스크 ID 명시 (예: `[T3] align: KRX-US holiday mismatch`).

## 1. 환경 셋업 (T0)

```bash
python 3.11+ / venv
pip install pandas numpy statsmodels pyarrow pytest pykrx yfinance pandas-datareader exchange-calendars pytz
```
- 레포 구조는 스펙 §4를 따르되 1주차는 `config.yaml, src/fetch.py, src/align.py, tests/, data/raw/, reports/`만 생성.
- `config.yaml` 초안: 티커 목록(스펙 §2.1 전체), 기간 `2023-01-01 ~ 현재`, 캐시 경로,
  타임존 상수(`Asia/Seoul`, `America/New_York`), 거래소 캘린더 키(XKRX, XNYS).

## 2. T1 — 데이터 조달 판정 (스펙 §2.1~§2.4) — **이번 주 최우선**

각 소스에 대해 실제 다운로드를 시도하고 다음을 판정한다:

| 검사 항목 | 기준 |
|---|---|
| 기간 커버리지 | 2023-01-01 이후 결측률 < 2% |
| 수정주가 여부 | 삼전 액면분할·배당락 전후 연속성 확인 |
| 타임스탬프 의미 | 종가 기준 시각이 명확한가 (특히 FRED 금리의 **게시 지연** — DGS2가 당일 07:15 KST에 존재하는지 실측) |
| available_by_0715 | 라이브 R1 시점 가용 여부 판정 → 소스별 플래그 확정 |

**소스별 지시:**
- **A등급 후보** (§2.1 표 전체): pykrx(005930/000660/KOSPI200), yfinance(^GSPC, SOXX, TSM, MU, NVDA, EWY, KRW=X, SMSN.IL, ^N225, ^AXJO), FRED(DGS2, DGS10). 전부 시도.
- **B등급** (§2.4): KRX 야간선물 히스토리, TAIFEX 야간선물, 니케이 선물 조기 세션 —
  공개 소스 존재 여부를 조사하되 **크롤링·비공식 API에 시간을 쓰지 말 것** (조사 상한: 소스당 1시간).
  결과가 '조달 불가'면 그것이 정상적인 판정 결과다.
- **C등급**: 미 시간외 히스토리, 동시호가 예상체결가 — 시도하지 않고 '오프라인 제외 확정'으로 기재 (스펙 §2.4).
- **일중 데이터** (§2.2): yfinance 일중 조회의 기간 제한을 실측하고, CLV_us·last30m·breadth
  3변수의 구현 가능 여부를 판정. breadth는 RSP/SPY 프록시 계획을 기재.
- GDR(SMSN.IL): 통화 단위(USD 표시 여부) 확인 — 원화 환산 로직에 필요한 메타를 기록.

**산출물: `reports/AUDIT.md`** — 소스별 등급 확정표 + available_by_0715 플래그표 +
**발주자 결정 필요 항목** (B등급 조달 실패분의 검증 이관 확인 등)을 별도 절로.

## 3. T2 — fetch.py

- 소스별 수집 함수 + parquet 캐시 (`data/raw/{source}.parquet`), 멱등 실행 (캐시 존재 시 증분만).
- 각 레코드에 `source, fetch_ts, data_date` 컬럼 필수.
- 수정주가·통화·단위 정규화는 여기서 하지 않는다 (align 이후 단계 소관 — 1주차 범위 밖).

## 4. T3 — align.py (이번 주의 본체, 테스트 우선 개발)

### 4.1 구현 요구 (스펙 §2.3)

```
핵심 함수: build_night_panel(start, end) -> DataFrame
  각 행 = "하나의 밤": (us_trade_date t, krx_next_open_date d+1) 쌍
  컬럼: 미국 세션 변수들(t), 아시아 당일 변수들, KRX 라벨(gap = ln(open_{d+1}/close_d)),
        플래그(multi_session, us_holiday_skip, ex_date, available_by_0715 통과 변수 목록)
```

규칙 (스펙 §2.3 그대로):
1. 미 휴장·KRX 개장일 → 표본 제외 (`us_holiday_skip` 기록)
2. KRX 휴장·미 개장일 → 미국 2세션 누적 후 매핑, `multi_session=True`, 기본 회귀 제외 플래그
3. 캘린더는 exchange_calendars(XKRX/XNYS) 사용 — 수기 휴일 리스트 금지
4. **전수 assert**: 모든 행에서 `us_close_ts(America/New_York→UTC) < krx_open_ts(Asia/Seoul→UTC)`.
   위반 1건이라도 발견 시 예외 발생·파이프라인 중단 (경고로 낮추지 말 것)
5. 서머타임 전환 주간 처리는 타임존 라이브러리에 위임하되 테스트로 검증 (수동 오프셋 계산 금지)
6. 락일: pykrx 배당·분할 이벤트로 `ex_date` 플래그 생성 (AdjEx 계산 자체는 2주차)

### 4.2 tests/test_align.py — 최소 케이스 (코드보다 먼저 작성)

1. 평상 밤: 미 화요일 세션 → KRX 수요일 시가 매핑
2. 미 휴장(추수감사절)·KRX 개장 → 표본 제외 확인
3. KRX 연휴(설)·미 개장 → multi_session 누적 확인
4. 미 반일장 → 정상 포함 + 플래그
5. 서머타임 전환 주간 (3월·11월 각 1주) → assert 통과 확인
6. 룩어헤드 주입 테스트: 고의로 잘못된 타임스탬프 1건 삽입 → 예외 발생 확인
7. 금요일 밤 → KRX 월요일 매핑
- 통과 기준: 전 케이스 green + 2023~현재 전 기간 build 시 assert 위반 0건.

## 5. T4 — 배관 스모크 테스트 (모델링 아님)

- night_panel 위에서 단 2개 회귀만: `KOSPI200 gap ~ r_SPX` (지수 I0), `하닉 gap − β_mkt·지수 gap ~ soxx_ex` (고유 S0, soxx_ex는 임시 전기간 직교화 — **스모크 한정 허용, 본 구현은 롤링**임을 코드 주석에 명기).
- 목적: 데이터→정렬→회귀가 관통되는지 + R² 자릿수가 사전 등록 예상(스펙 §5)과 같은 우주에 있는지.
- 산출: `reports/WEEK1_REPORT.md`에 R²·표본수·기간만 기재. **해석·튜닝 금지.**

## 6. 완료 기준 (Definition of Done)

- [ ] `AUDIT.md`: 전 소스 등급 확정 + available_by_0715 표 + 발주자 결정 필요 목록
- [ ] `pytest` 전체 green, 전 기간 night_panel 빌드 assert 위반 0건
- [ ] night_panel 요약 통계 (밤 수, multi_session 수, 제외 수, 결측 컬럼별 %)
- [ ] 스모크 회귀 2건 수치 보고
- [ ] `WEEK1_REPORT.md`: 위 전부 + 스펙 충돌 목록 + 2주차 착수 조건 제안

## 7. 하지 말 것

- ortho.py·channels.py·sigma.py 본 구현 (2주차 범위)
- B등급 소스에 대한 우회 크롤링·유료 가입 판단 (발주자 결정 사항)
- 스모크 회귀 결과를 근거로 한 어떤 파라미터 조정
- 스펙 문서 수정
