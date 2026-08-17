"""MT-PRO 이벤트 모듈 (부품 0 전제, WORKORDER v10.1 T1-3 + 발주자 개정 D3 2026-08-17).

- registry: 컨센서스 레지스트리(parquet). 사전 동결·vintage·사후 수정 거부.
- calendar: 등급A 7종 공식 일정(config/event_calendar.yaml).
- collectors: 소스별 자동 수집기(us_macro / kr_earnings / nvda).
- scheduler: D-3/D-1 수집 → 반영 → D-1 동결 → 실패 시 alert + 등급C 격하.
- cli: 수동 1건 입력·동결·조회.
"""
