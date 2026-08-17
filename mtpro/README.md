# MT-PRO — 방법론 독립 프로젝트 (WORKORDER_MTPRO_v10.1 + AM-5)

- 발주서: `WORKORDER_MTPRO_v10.1.md` (2026-08-16). AM-5(8/17)로 이 저장소 `mtpro/`에 편입(이전 별도 git 이력: docs/mtpro-git-history-pre-merge.txt). 독립 = 방법론 독립(v0.4 비교 없음·naive baseline·자체 관문). KIS 전용 앱키·`.env`·토큰 캐시는 기존 시스템과 계속 분리.
- 진행: T1 조달 실측(`docs/mtpro-t1-procurement.md`, 승인) → **T2 완료**(`docs/mtpro-t2-report.md`, 테스트 92) → 결정 5건 반영·AM-5 이관 → **T3 착수**.
- 실행: `python -m venv .venv && .venv\Scripts\pip install -r requirements.txt` · 테스트 `.venv\Scripts\python -m pytest tests -q` · 컨센서스 CLI `.venv\Scripts\python -m mtpro.events.cli --help`
- 비밀: `.env`(KIS 전용 실전 키, git 제외) · 토큰 캐시 `.cache/kis_token.json` · 알림 `logs/alerts.jsonl` · 데이터 `data/{bronze,silver,gold}` (전부 git 제외)
- 프로브: `probes/` (T1·T2 실측 스크립트·출력). KRX 계정은 env `KRX_ID/KRX_PW`.
- 접수 이력: `../docs/mt-pro-intake.md` · 실행은 `mtpro/` 안에서(경로는 settings.ROOT 기준 상대).
