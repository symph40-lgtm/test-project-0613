# MT-PRO 컨센서스 자동 수집·자동 동결 — 구현 기록 + 수집기 실측 (2026-08-17)

발주자 개정 D3 (2026-08-17): 컨센서스 **수동 등록 → 자동 수집 + 자동 동결**. 등급A 7종 확정(FOMC·미 CPI·미 고용·미 PCE·삼성전자 잠정·SK하이닉스·NVDA), 금통위 제외. 국내 자산 이벤트 전부 `t0_mode="A1_open"`.

## 1. 구성

| 파일 | 역할 |
|---|---|
| `src/mtpro/events/registry.py` | parquet 레지스트리 `data/silver/consensus_registry.parquet`. register_event / upsert_consensus(동결 전만) / freeze / supersede(정정=새 행) / set_actual / get / list. 동결 후 UPDATE → `FrozenError`, `vintage_ts >= scheduled_ts_utc` → `VintageError`, 값 없이 동결 → `grade="C"` |
| `config/event_calendar.yaml` + `src/mtpro/events/calendar.py` | 7종 공식 일정 소스 URL·발표 시각 규칙(현지 tz → UTC, DST 자동)·t0_mode·asset_scope 기본값 + 2026 하반기 실제 일정(확인/미확인 표기) |
| `src/mtpro/events/collectors/{us_macro,kr_earnings,nvda}.py` | 소스별 `collect(event) -> {value, unit, source, source_url, fetched_at, raw}` 또는 `CollectError` |
| `src/mtpro/events/scheduler.py` | `run_collection(now, calendar, registry, collectors, alert)`: D-3/D-1 선별 → 수집 → 반영 → D-1 동결 → 실패 시 alerts + 등급C 격하. 수집기·alert·now 주입 |
| `src/mtpro/events/cli.py` | `add-manual` / `freeze` / `supersede` / `set-actual` / `show` / `calendar` / `run [--dry-run]` |
| `src/mtpro/alerts.py` | `loud_failure(kind, detail)` → `logs/alerts.jsonl` append + stderr |
| `tests/test_registry_freeze.py`, `test_scheduler.py`, `test_calendar.py`, `test_collectors_parse.py` | 34 테스트 |

### 스케줄러 단계 규칙 (UTC 날짜 차이 `days_left`)
- **D-3**: `days_left == 3` (놓쳤으면 2도, 값 없을 때만) → 수집만. 실패 = `COLLECT_FAIL` alert, 발주자 `add-manual` 가능.
- **D-1**: `days_left == 1` (놓쳤으면 0, 발표 전) → 수집 후 **무조건 동결**. 값 없으면 `grade C` + `DEGRADE_C` alert. 자동 수집 성공 시 수동값을 덮어씀(동결 전 upsert), 실패 시 수동값이 그대로 동결(grade A).
- **late**: 발표 시각 경과·미동결(미등록 포함) → 수집 없이 즉시 동결(값 없으면 C) + `LATE_FREEZE` alert. 사후 값 입력은 vintage 규칙이 막는다.
- `status: unconfirmed` 일정은 `UNCONFIRMED_SCHEDULE` alert 를 남기고 동일 처리.
- 크론 권장: 매일 1회(UTC 00~06시 사이) `python -m mtpro.events.cli run` — 미설치(발주자 승인 후).

## 2. 수집기 실측표 (2026-08-17 08:00~08:40 UTC, `.venv` requests/bs4/yfinance 1.6.0)

| 소스 | 대상 | URL | 결과 | 파싱된 값 예시 | 실패 원인 / 제약 |
|---|---|---|---|---|---|
| **ForexFactory 주간 JSON** | 미 매크로 4종 | `https://nfs.faireconomy.media/ff_calendar_thisweek.json` | **성공** (HTTP 200, 96행/USD 19행, `forecast` 필드) | `Unemployment Claims 2026-08-20 forecast "210K"` → (210.0, "K"); `Philly Fed 24.3` 등. 우리 4종은 이번 주 피드에 없어(다음 이벤트 8/26 PCE) 제목 매핑(`Federal Funds Rate`/`CPI m/m`/`Non-Farm Employment Change`/`Core PCE Price Index m/m`)은 FF 표준 명칭 기준·**실매칭 미검증** | ① 이번 주(일~토 ET) 1주치만 — `nextweek` 피드 404 → 월/화 이벤트의 D-3(전주)은 피드 밖 → CollectError(D-1은 항상 같은 주). ② **연속 호출 수 회 → HTTP 429**(실측, 약 10분+ 지속) → 모듈 캐시 10분으로 1실행 1요청 |
| investing.com 경제 캘린더 | 미 매크로 4종 (폴백) | `https://www.investing.com/economic-calendar/`, `sslecal2.investing.com` 위젯 | **실패** HTTP 403 (봇 차단, 본문 "403") | — | Cloudflare 차단. 파서 미구현(200이 와도 CollectError로 정직 보고). 대안 후보: FF 피드(채택), TradingEconomics 캘린더(구독), MarketWatch 캘린더 HTML(미실측) |
| **네이버금융 종목분석(FnGuide)** | 삼성전자 잠정·SK하이닉스 | `finance.naver.com/item/coinfo.naver?code=005930` 의 iframe → `navercomp.wisereport.co.kr/v2/company/c1010001.aspx?cmp_cd=005930` → `ajax/cF1001.aspx?freq_typ=Q&encparam=…` | **성공** (HTTP 200, 2단계: 페이지에서 `encparam`·`id` 추출 후 AJAX, Referer 필수) | 005930 `2026/09(E)` 영업이익(발표기준) **1,139,748 억원**; 000660 `2026/09(E)` **788,277 억원** (2026-08-17 08:25 UTC) | `finance.naver.com/item/main.naver` 의 기업실적분석 표는 (E) 1분기만 노출(대상 분기 없을 수 있음) → 사용 안 함. 대상 분기 컬럼이 (E)가 아니거나 없으면 CollectError(다른 분기 대체 금지). `m.stock.naver.com/api/stock/{code}/integration` 은 투자의견·목표가만(consensusInfo), 실적 컨센서스 없음. `comp.fnguide.com/SVO2/asp/SVD_Consensus.asp` 는 200이나 1.8KB(JS 리다이렉트) — 미채택 |
| **yfinance** | NVDA | `yf.Ticker("NVDA").earnings_dates` → 폴백 `.calendar` | **성공** | `earnings_dates` 2026-08-26 16:00 ET **EPS Estimate 2.08** (calendar: Earnings Date 2026-08-27, Earnings Average 2.0838 — Yahoo 날짜가 공식 8/26과 1일 어긋남 → ±2일 허용) | 다음다음 분기(NVDA_EARN_20261118)는 아직 행 없음 → CollectError(당연; D-3 시점엔 현재 분기가 됨). yfinance 비공식 API — 구조 변경 위험 |

투자 결론: 미 매크로 = **ForexFactory 피드 채택**(investing.com 불가), 국내 = **네이버 종목분석 iframe(WiseReport/FnGuide) 채택**, NVDA = **yfinance 채택**. 값 재사용 없음(조달 여부 확인 목적).

## 3. 캘린더 2026 하반기 — 확인/미확인

| event_id | 상태 | 근거 |
|---|---|---|
| FOMC_20260916 / 20261028 / 20261209 | 확인 | federalreserve.gov 캘린더(2026-08-17 조회): 9/15-16*, 10/27-28, 12/8-9* — **발주 문구의 "9/16-17"은 오기, 성명 = 9/16(수) 14:00 ET** |
| US_CPI_20260911 / 20261014 / 20261110 / 20261210 | 확인 | bls.gov 직접 조회 403 → OMB PFEI CY2026 일정표(whitehouse.gov PDF, 2025-09 발행) "Consumer Price Index … 12 11 14 10 10" + BLS 보도자료 검색(9/11 8:30 AM) |
| US_NFP_20260904 / 20261002 / 20261106 / 20261204 | 확인 | OMB PFEI CY2026 "Employment Situation … 7 4 2 6 4" + BLS 보도자료 검색(9/4) |
| US_PCE_20260826 / 20260930 / 20261029 / 20261125 / 20261223 | 확인 | bea.gov/news/schedule 직접 조회(2026-08-17): 8/26·9/30·10/29·11/25·12/23 8:30 AM |
| NVDA_EARN_20260826 | 확인 | NVIDIA Newsroom(2026-07-30) 2Q FY27 — 8/26 결과 ≈13:20 PT, 콜 14:00 PT |
| NVDA_EARN_20261118 | **미확인** | 3Q FY27 미공고. 과거 패턴(11월 셋째 주 수) 추정 |
| SEC_PRELIM_20261008 | **미확인** | 3Q26 잠정 미공고. 분기 종료 후 5영업일 내 패턴(2Q26=7/7) → 10/6~10/8 추정 |
| HYNIX_EARN_20261022 | **미확인** | 3Q26 미공고. 10월 넷째 주 목 패턴 추정 |

미확인 3건은 공고 확인 즉시 yaml `local_date`·`event_id` 갱신(변경 = amendment 기록). 스케줄러가 대상 선별 시 `UNCONFIRMED_SCHEDULE` alert 를 남긴다.

## 4. 열린 사항 (발주자)
1. FF 피드 1주 한계로 월/화 이벤트 D-3 수집이 구조적으로 실패 → D-1 단독 의존. 허용 여부(대안: D-2 캐치업은 이미 구현, 또는 D-3을 "직전 일요일 이후 첫 실행"으로 재정의).
2. 자동 D-1 수집이 성공하면 수동값을 덮어쓴다(현 구현). 수동값 우선을 원하면 규칙 변경 필요.
3. CPI 컨센서스 필드 = 헤드라인 m/m 1개(코어 아님), PCE = 코어 m/m 1개, FOMC = 금리 상단 — 필드 선택 확정 요청.
4. 크론 등록·`logs/alerts.jsonl` 문자 연동은 미구현(범위 밖).
