# MT-PRO 라이브 운영 (홈PC 크론) — `jobs/live_daily.py` (T5-6, 2026-08-17)

스펙: `docs/mtpro-t5-plan.md` §11 T5-6("라이브 크론(홈PC)·loud-failure") + 발주자 KIS 지시(전용 키 `mtpro/.env`, 토큰 캐시 `mtpro/.cache/kis_token.json`, 기존 시스템 env·캐시 접근 금지). config `live` 블록과 step 목록 일치(테스트 `tests/test_live_daily.py`).

## 1. 무엇을 하나 (평일 16:10 KST 1회)

| 순서 | step | 명령(모두 `mtpro/.venv\Scripts\python.exe`) | 하는 일 | 실패 시 |
|---|---|---|---|---|
| a | `consensus_scheduler` | `-m mtpro.events.cli run` | D-7 재확인 알림 · D-3/D-1 컨센서스 수집·동결(등급A/C) | COLLECT_FAIL/DEGRADE_C 알림은 잡 안에서, rc≠0 이면 LIVE_STEP_FAIL |
| a | `build_events_kr` | `jobs/build_events_kr.py` | t0_kr·독립성·verify_eligible 파생 갱신 | LIVE_STEP_FAIL |
| b | `ingest_krx` | `jobs/ingest_krx.py --only flow,ohlcv_unadj,ohlcv_adj,pit,const_ohlcv` | KRX 증분(pykrx, `.env.local` 의 KRX_ID/KRX_PW 만) — const_flow(C-1 대사 캐시)는 제외 | PROCURE_FAIL + LIVE_STEP_FAIL |
| b | `accumulate_minutes` | `jobs/accumulate_minutes.py` | KIS 1분봉 증분(005930·000660, 당일은 15:40 이후) — 결측 세션 → `MINUTE_GAP` + rc 4 | LIVE_STEP_FAIL(rc 4 = 결측, rc 2 = KIS/설정) |
| c | `build_flow` → `build_breadth` → `build_semi_diffusion` → `build_gap3g`(^SOX 증분) → `build_transmission`(SOXX·NVDA·MU·TSM 증분) → `build_psa` → `build_expected_reaction`(^VIX·^TNX 증분, 등급A 0건이면 0행) → `build_absorption` → `build_mt_state`(있으면) | 각 `jobs/*.py` | gold 패널 재산출(전 구간 재계산 — 과거 전용 창이라 결과 불변) | LIVE_STEP_FAIL |
| d | 종료 | — | 실패 step 이 하나라도 있으면 **종료코드 1** (계속 진행이 기본, `--stop-on-fail` 로 중단 가능) | `logs/alerts.jsonl` 에 `LIVE_STEP_FAIL{step, rc, tail}` |

- 로그: `logs/live_daily_{YYYY-MM-DD}.log` (각 step stdout/stderr 원문) + `logs/live_daily_{date}.json` (step 별 rc·초·tail).
- 옵션: `--dry-run`(계획만) · `--only a,b` · `--skip a,b` · `--step-timeout 3600` · `--date` (로그 파일명) · `--stop-on-fail`.
- 소요(8/17 실측 기준 추정): ingest_krx 증분 1~3분, accumulate_minutes 증분 ≈ 8초/종목·일(7호출), 부품 잡 각 10~60초 → 통상 5~10분. 최초 실행(분봉 12개월 소급)은 ≈ 35분(2종목 × 245세션 × 7호출, 호출당 ≈0.5초).

## 2. 사전 조건 (한 번만)

1. `mtpro/.env` — `KIS_APP_KEY`, `KIS_APP_SECRET`, `KIS_ENV=real` (전용 앱키. **다른 프로세스가 같은 앱키로 토큰을 발급하면 서로 무효화**되므로 이 키는 mtpro 만 쓴다). `settings.env()` 는 이 파일만 읽고 프로세스 환경의 KIS_* 는 읽지 않는다.
2. `../.env.local` — `KRX_ID`, `KRX_PW` (pykrx 로그인; `settings.krx_env()` 가 두 키만 읽는다).
3. `.venv` 에 requirements 설치, `exchange_calendars` 포함(XKRX 캘린더 — 실패 시 관측 거래일 폴백 + `XKRX_FALLBACK` 알림).
4. 최초 1회 수동: `python jobs\accumulate_minutes.py` (12개월 소급, ≈35분) → `python jobs\live_daily.py --dry-run` → `python jobs\live_daily.py`.

## 3. Windows 작업 스케줄러 등록 (관리자 PowerShell 또는 cmd, 경로는 실제 위치로)

```bat
schtasks /Create /F /TN "MTPRO_live_daily" ^
  /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 16:10 ^
  /TR "\"D:\vivecoding\test project_0613\mtpro\.venv\Scripts\python.exe\" \"D:\vivecoding\test project_0613\mtpro\jobs\live_daily.py\"" ^
  /RL LIMITED
```

- 확인: `schtasks /Query /TN "MTPRO_live_daily" /V /FO LIST` · 즉시 실행: `schtasks /Run /TN "MTPRO_live_daily"` · 삭제: `schtasks /Delete /TN "MTPRO_live_daily" /F`.
- 작업 스케줄러 GUI 에서 권장 설정: "사용자가 로그온했는지 여부에 관계없이 실행"(사용자 암호 저장), "AC 전원에서만 시작" **해제**, "예약된 시작 시간을 놓친 경우 가능한 빨리 작업 시작" **체크**(PC 꺼져 있던 날 보정 — 다음 부팅 시 실행되며 KRX/KIS 자료는 그대로 증분된다), 조건 "절전 모드 해제하여 실행" 체크.
- cwd 는 잡이 `ROOT` 기준 절대 경로로 잡으므로 "시작 위치" 미설정이어도 된다. 스크립트가 `PYTHONIOENCODING=utf-8` 로 하위 잡을 실행하므로 콘솔 코드페이지와 무관.
- 휴장일에 돌아도 무해(증분 0, 분봉 계획 0). KRX 휴장 = XKRX 캘린더 기준(당일 세션 아님 → 당일 분봉 없음).

## 4. 실패 확인 루틴 (사람이 보는 것)

- `logs/alerts.jsonl` 마지막 줄들: `LIVE_STEP_FAIL`(어느 step, rc, tail) · `MINUTE_GAP`(빠진 세션 목록) · `PROCURE_FAIL` · `COLLECT_FAIL`/`DEGRADE_C`(컨센서스) · `XKRX_FALLBACK`.
- `logs/live_daily_{date}.json` `exit_code`·`failed_steps`.
- KIS 401/403 반복 → 다른 프로세스가 같은 앱키로 토큰을 재발급했는지 확인(캐시 `mtpro/.cache/kis_token.json` 지우고 재실행). KIS 유량: 하루 증분 2종목 × 7호출 = 14호출(호출 간 0.15초) — 실시간 계정 유량(초당 20건) 안.
- `MINUTE_GAP` 이 계속 뜨는 세션: 자동 재시도 3회 후 상태 파일(`data/bronze/minute/{code}/_status.json`)에 `empty` 로 남는다 → 실제 KRX 임시휴장/캘린더 불일치인지 확인 후 발주자 판단(그 날 부품 3 은 None 으로 유지, 0 대체 없음).

## 5. 범위 밖·확인 사항

- KOSPI200 **지수 분봉은 미적재**(TR `FHKUP03500200 inquire-time-indexchartprice` 가 종목 분봉과 다름) — 부품 3 장중은 005930·000660 만. 지수 확장은 발주자 결정 후 별도.
- 문자/푸시 연동 없음(config `consensus.alerts: [alerts_jsonl, stderr]`, T6 직전 재결정).
