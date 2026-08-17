# MT-PRO T2 보고 — 저장소·스키마·인프라·컨센서스 자동수집·정오표 test-first (2026-08-17)

- 발주: WORKORDER_MTPRO_v10.1 §4 T2 + 발주자 지시 8/17 (KIS 전용 실전 키 ①~④, D3 개정 = 자동 수집·자동 동결, 등급A 7종·금통위 제외, 국내 부품 3 = A-1 단일·원형 경로 SOXX 전용).
- 상태: **T2 완료.** 테스트 92 passed. 부품 4·5 등 T3 코드는 작성하지 않음.

## 0. 보안·분리 (지시 ①②④) — 이행 + 발견 1건
| 항목 | 결과 |
|---|---|
| `.env` git 제외 | `.gitignore` 4행 `.env`, 추가로 `.env.*`·`.cache/`·`logs/`·`data/` 무시. `git check-ignore` 확인, 커밋 이력에 .env 없음 |
| **발견**: `mtpro/.env` 부재, 새 키 5줄이 **기존 저장소 `.env.local` 38~42행**에 있었음(기존 라이브 키 36~37행과 `KIS_APP_KEY/SECRET` 중복 — dotenv는 뒤 값이 이기므로 로컬 구동 시 라이브 시스템이 새 키를 쓰게 되는 상태) | 5줄을 `mtpro/.env`로 **이동**, `.env.local` 원상 복구(백업 `.env.local.bak-20260817`, git 무시 — 확인 후 삭제 권장). 실전 키 값은 어디에도 출력하지 않음 |
| 완전 분리 | `settings.env()`는 **mtpro/.env만** 읽고 프로세스 환경변수의 KIS_*는 무시(`MTPRO_` 접두만 허용) → 다른 시스템 env 유입 차단. 기존 앱키·토큰 캐시 접근 코드 없음 |
| 토큰 캐시 경로 (지시 ④) | **`D:\vivecoding\mtpro\.cache\kis_token.json`** (앱키 앞 6자 지문으로 키 교체 시 무효화, 만료 5분 전 재발급, 401/403 시 1회 재발급 후 loud-failure) |

## 1. T2 첫 검증 (지시 ③) — `probes/t2_kis_minute_probe.py`·`t2_kis_depth_probe.py`
| 실측 | 결과 |
|---|---|
| 토큰 발급 (real 도메인 `openapi.koreainvestment.com:9443`, `oauth2/tokenP`) | **성공 0.55초**, 발급 2026-08-17 17:09:24 KST, 만료 +24h |
| 국내주식 분봉 `FHKST03010230` 005930 2026-08-14 | **381봉 09:00~15:30**, 7호출(60분 앵커), 원시 781행 → 중복 제거 |
| 이력 깊이 | 60·118·125·140·240·300일 전 61봉 ✓ · **2025-08-14(368일 전) ✓ · 2025-07-11 ✗** → **국내 1분봉 ≈ 12개월**(기존 시스템 "120일" 가정의 3배; T1-4 표기 갱신). 휴장일(설 2/16~18·8/15) 요청 시 직전 거래일 봉이 오는 함정 → `stck_bsop_date == 요청일` 필터로 0봉 처리 확인 |
| 유량 | 호출 간 0.15초, 오류 없음 |

## 2. 만든 것
| 영역 | 파일 | 요지 |
|---|---|---|
| 설정 | `src/mtpro/settings.py`, `config/mtpro.yaml`, `requirements.txt`, `.venv` | 상수 사전 등록(7종·A1_open·C-1 대사 규칙·분모·분위·KIS 깊이) |
| KIS | `src/mtpro/kis/client.py`, `kis/minute.py` | 전용 키·캐시·분봉 어댑터 |
| 스키마 | `src/mtpro/schema.py` + `tests/test_schema_c2_c3.py` | bronze(수급·OHLCV·시총·구성종목·분봉)·silver(레지스트리·월별 구성)·gold 메타. **C-2 `price_adjusted` 필수 + 혼용 assert, C-3 `t0_mode` + 국내=A1_open·SOXX=release_time assert** |
| 정오표 A-1~A-6 | `src/mtpro/core/errata.py`, `tests/test_errata_a1..a6.py` (58 tests) | test-first. A-1 유형별 rolling std(검증 "실패 가능"함 증명) · A-2 확률합=1·fallback(prev 유지/uniform)+감점 · A-3 전환 임계(마진 0.15·2일 연속) · A-4 표본 부족 None+"insufficient" · A-5 `1/n_overlap`, A1은 동일 개장일·release_time ±30분 · A-6 None 제외·재정규화·가용<3 None, delta ±100 클립 |
| 컨센서스 | `src/mtpro/events/{registry,calendar,scheduler,cli}.py`, `collectors/{us_macro,kr_earnings,nvda}.py`, `alerts.py`, `config/event_calendar.yaml`, 테스트 34 | 상세 `docs/mtpro-t2-consensus-collectors.md` |

## 3. 컨센서스 자동 수집 실측 (8/17 17:00~17:40 KST)
| 소스 | 대상 | 결과 |
|---|---|---|
| ForexFactory 주간 JSON | 미 매크로 4종 | **성공**(forecast 파싱). 제약: **이번 주 1주치만**(D-3가 주 경계 밖이면 D-1 단독) · 연속 호출 시 **429**(10분 캐시로 대응) |
| investing.com | 폴백 | **실패 403**(봇 차단) — 파서 미구현, 정직 기록 |
| 네이버금융 → wisereport(FnGuide) ajax | 삼전·하닉 | **성공** (005930 2026/09(E) 영업이익 1,139,748억 · 000660 788,277억) |
| yfinance `earnings_dates` | NVDA | **성공** (8/26 EPS est 2.08; Yahoo 날짜 ±1일 어긋남 → ±2일 허용) |
| 캘린더 확인 | FOMC 9/16·10/28·12/9(**발주 문구 "9/16-17"은 오기 — 회의 9/15-16, 성명 9/16 14:00 ET**), CPI·NFP·PCE 하반기 전 일정, NVDA 8/26 | 미확인 3건(삼전 잠정 10/8·하닉 10/22·NVDA 11/18 — 공고 후 갱신) |
- 규칙 구현: D-3 수집 → D-1 수집+**무조건 동결**(값 없으면 등급C `DEGRADE_C`) → 발표 경과 미동결은 즉시 C(`LATE_FREEZE`). 실패는 `logs/alerts.jsonl` + stderr(`COLLECT_FAIL`). 동결 후 수정 = `FrozenError`, 사후 vintage = `VintageError`, 정정은 `supersede`(새 행)만. 캘린더 밖 event_id 수동 등록 거부.

## 4. 사양 이탈 후보 — amendment 기록 요청 (조용한 수정 아님, 코드 docstring·상수로 노출)
| # | 내용 | 이유 |
|---|---|---|
| AM-2 | `delta_from_history`의 z 기준 분포 = **최근 창 이전** 변화량, std 하한 1.0 | 원 사양(최근 창 포함)은 \|z\|≲√n/2로 자기 정규화되어 ±100 도달 불가 |
| AM-3 | A-2 fallback 감점 10(prev 유지)/20(uniform), A-5 asset_scope 다르면 비겹침 | 제안 상수 |
| AM-4 | 자동 D-1 수집 성공 시 수동값을 덮어씀(현 구현) | 수동 우선 원하면 규칙 변경 |

## 5. 발주자 결정 요청
1. ForexFactory 1주 한계로 **월·화 이벤트는 D-1 단독 수집**이 되는 구조 — 허용 여부(대안: TradingEconomics 유료·MarketWatch 미실측).
2. 컨센서스 **필드 확정**: CPI 헤드라인 m/m · PCE 코어 m/m · FOMC 금리 상단 · NFP 헤드라인(현 기본값).
3. AM-2~AM-4 승인/수정.
4. 크론 등록(홈PC 작업 스케줄러: `python -m mtpro.events.cli run` 매일 1회) + alerts 문자 연동 — 범위 밖으로 미구현. 문자는 기존 시스템 SOLAPI와 **분리**해야 하므로 별도 키 필요 여부 결정.
5. T3 착수 허가 (부품 4·5 → 등급C 0~2 → Energy-Lite, C-1 대사 1회).

*T2 종료. 부품 코드 0줄(부품 4·5 미착수). 테스트 92 passed.*
