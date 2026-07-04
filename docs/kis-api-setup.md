# KIS(한국투자증권) 오픈API 키 발급 가이드

용도: 코스피200 **야간선물 실시간 시세** (`lib/market/kis.ts`, 신호 시스템 M7 확장 데이터).
없어도 앱은 정상 동작 — 야간선물 표시만 네이버 정규장 폴백.

## 준비물
- 한국투자증권 계좌 (없으면 "한국투자" 앱에서 비대면 개설)

## 절차

1. **포털 가입** — https://apiportal.koreainvestment.com (평일 낮 접속 권장 — 주말·심야 점검 잦음)
   - 회원가입 → 계좌 인증 (기존 홈페이지 ID 있으면 그대로 로그인)
2. **API 신청 (앱 등록)** — 상단 "API신청" 메뉴
   - **실전투자** 선택 → 계좌번호 선택 + 약관 동의 → 신청
   - 승인 후 **APP Key / APP Secret** 발급 (마이페이지 > API신청 내역에서 재확인 가능)
3. **야간선물 종목코드** — `KIS_FUT_CODE`
   - "(야간)코스피200 선물" 최근월물 코드 (예: `101W09` 형식, 월물 교체 시 갱신 필요)
   - HTS/MTS 종목 검색 또는 포털의 종목정보 파일에서 확인
4. **환경변수 등록**
   - Vercel: Settings > Environment Variables에 `KIS_APP_KEY` `KIS_APP_SECRET` `KIS_FUT_CODE` 추가 → **Redeploy**
   - 로컬: `.env.local`에 같은 3줄 추가
   - (선택) `KIS_FUT_TRID` — 시세 조회 tr_id, 기본값 `FHMIF10000000`

## 주의
- APP Secret은 비밀번호처럼 취급 (채팅·문서·커밋 금지)
- 키 유효기간 1년 — 만료 전 포털에서 갱신
- 토큰 발급은 분당 제한이 있어 코드에서 24h 메모리 캐시함 (`lib/market/kis.ts`)
