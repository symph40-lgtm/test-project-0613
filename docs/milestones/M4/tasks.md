# Tasks: M4 — 장중 알림 & 마감 전 판단

---

## [x] Task T001 — DB 마이그레이션: alerts 테이블

**Description:** 알림 이력을 저장하는 `alerts` 테이블을 생성한다. 발송 상태·읽음 확인·알림 내용 JSON을 저장해 장중 알림 화면과 갭 리포트(M5)에 활용한다.

**Acceptance Criteria:**
- [ ] `supabase/migrations/008_alerts.sql` 작성:
  - 컬럼: `id`, `user_id`, `trigger_key` (text, CHECK IN ('low','drop5','futures','rebound','intraday_summary','approval')), `ticker` (nullable), `severity` (text, CHECK IN ('high','medium','low')), `message` (jsonb), `market_snapshot` (jsonb), `is_sent` (boolean), `sent_at` (timestamptz), `read_at` (timestamptz), `created_at`, `updated_at`
  - UNIQUE 없음 (같은 trigger_key도 다중 발송 가능)
  - RLS: 사용자 본인 row만 SELECT/UPDATE 가능, INSERT는 서비스 롤로 처리
  - `updated_at` 트리거
- [ ] `.env.example`에 `CRON_SECRET=` 추가

**Verification:**
- [ ] `npm run build` 성공
- [ ] SQL 파일 문법 검토 (Supabase SQL Editor에서 사용자 직접 실행)

**Dependencies:** 없음

**Likely Files:**
- `supabase/migrations/008_alerts.sql` (신규)
- `.env.example` (수정)

**Estimated Scope:** XS

---

## [ ] Task T002 — 알림 트리거 평가 로직

**Description:** 시장 데이터 + 사용자 risk_lines를 비교해 발동 조건을 평가하고 알림 강도를 분류하는 pure function을 구현한다.

**Acceptance Criteria:**
- [ ] `lib/alerts/triggers.ts` 구현:
  - `type AlertTrigger = { trigger_key: string; ticker: string | null; severity: 'high' | 'medium' | 'low'; reason: string }`
  - `evaluateAlertTriggers(market: MarketData, positions: PositionForAlert[], enabledLines: string[]): AlertTrigger[]`
    - `low` (is_on): KOSPI `changePercent < -2` OR SOX `changePercent < -2` → severity 'medium'
    - `drop5` (is_on): 나스닥 또는 SOX `changePercent < -5` → severity 'high'
    - `futures` (is_on): 나스닥 `changePercent < -3` AND 10Y 금리 `changePercent > 0` → severity 'high'
    - `rebound` (is_on): 나스닥 `changePercent > 1` BUT SOX `changePercent < 0` (반등 실패 시그널) → severity 'medium'
  - 레버리지 포지션 존재 시 해당 트리거 severity를 한 단계 상승 ('medium' → 'high')
  - `null`인 시장 지표는 해당 조건 skip
- [ ] 중복 방지: 같은 `trigger_key`에서 두 개 이상 AlertTrigger가 생성되지 않도록 dedup

**Verification:**
- [ ] 예시 입력(나스닥 -6%, SOX -7%)으로 `drop5` trigger_key AlertTrigger 반환 확인
- [ ] `npm run build` 성공

**Dependencies:** T001

**Likely Files:**
- `lib/alerts/triggers.ts` (신규)

**Estimated Scope:** S

---

## [ ] Task T003 — 알림 메시지 생성 + 이메일 발송 API

**Description:** AlertTrigger를 FR-013 형식의 메시지로 변환하고, 이메일로 발송 후 alerts 테이블에 저장하는 API 라우트를 구현한다.

**Acceptance Criteria:**
- [ ] `lib/alerts/compose.ts` 구현:
  - `type AlertMessage = { subject: string; action: string; prohibition: string; reasons: string[]; nonCompliance: { cause: string; vulnerableTicker: string; lossOutcome: string; indicatorsToCheck: string }; buffett: string }`
  - `composeAlertMessage(trigger: AlertTrigger, positions: PositionForAlert[], principles: PrincipleForAlert[], stage: string): AlertMessage`
    - trigger_key → 행동/금지 라벨 룩업 (규칙 기반, Claude 미사용으로 비용 절감)
    - 레버리지 종목이 있으면 `vulnerableTicker`에 해당 티커 포함
    - 활성 원칙 중 trigger_key와 관련된 원칙 문장을 `action`에 포함
- [ ] `app/api/alerts/send/route.ts` POST 구현:
  - Request body: `{ userId: string }` (서비스 롤로 호출)
  - 또는 Authorization 헤더로 보호 (CRON_SECRET 방식)
  - 로직:
    1. 사용자 포지션·risk_lines·원칙·알림 채널 조회
    2. `fetchMarketData()` 호출
    3. `evaluateAlertTriggers()` → 발동된 트리거 목록
    4. 오늘 이미 발송된 trigger_key는 skip (중복 방지)
    5. 각 트리거에 대해 `composeAlertMessage()` → `sendEmail()` → alerts INSERT
  - 알림 채널 `verified=true` & `consent_given=true`인 경우에만 발송
  - 이메일 미설정/미인증이면 alerts INSERT만 하고 발송은 skip

**Verification:**
- [ ] `RESEND_API_KEY` 미설정 환경에서 API 호출 → console에 이메일 로그 + DB에 alerts row 생성
- [ ] 같은 trigger_key 두 번 호출 시 중복 발송 없음 확인
- [ ] `npm run build` 성공

**Dependencies:** T001, T002

**Likely Files:**
- `lib/alerts/compose.ts` (신규)
- `app/api/alerts/send/route.ts` (신규)

**Estimated Scope:** M

---

## Checkpoint 1 — 알림 파이프라인 핵심 동작

- [ ] T001~T003 완료
- [ ] `/api/alerts/send` 호출 시 alerts 테이블에 row 생성
- [ ] console 이메일 로그로 FR-013 형식(행동·금지·이유·미준수 리스크) 확인
- [ ] `npm run build` 성공

---

## [ ] Task T004 — 장중 체결 → 브리핑 캐시 무효화 + 재판단

**Description:** 장중 체결(applyFills) 완료 후 오늘의 briefing_snapshots 캐시를 삭제해, `/briefing` 재방문 시 갱신된 포지션 기준으로 자동 재계산되게 한다. (SC-004 충족)

**Acceptance Criteria:**
- [ ] `app/positions/intraday/actions.ts`의 `applyFills` 수정:
  - 포지션 업데이트 완료 후, `briefing_snapshots`에서 오늘 날짜 + user_id row 삭제
  - 삭제 실패는 무시 (cache miss면 자동 재계산이므로 치명적이지 않음)
- [ ] 재판단 로딩 경험: `IntradayClient.tsx`에서 submit 후 "재판단 중..." 메시지 → `/briefing`으로 redirect
- [ ] `app/positions/intraday/IntradayClient.tsx`: submit 버튼 레이블을 "체결 반영 + 재판단" 으로 변경

**Verification:**
- [ ] 체결 입력 후 `/briefing`에서 포지션 변경이 반영된 새 판단이 표시되는 것 수동 확인
- [ ] `npm run build` 성공

**Dependencies:** T001

**Likely Files:**
- `app/positions/intraday/actions.ts` (수정)
- `app/positions/intraday/IntradayClient.tsx` (수정)

**Estimated Scope:** S

---

## [ ] Task T005 — 장중 알림 화면 실데이터 연결

**Description:** `/alerts/intraday` 화면에 DB에서 최신 알림을 조회해 실제 데이터로 표시한다. 페이지 로드 시 알림 평가 API도 자동 호출해 최신 상태를 유지한다.

**Acceptance Criteria:**
- [ ] `app/alerts/intraday/actions.ts` 신규 ("use server"):
  - `getLatestAlert(userId)`: alerts 테이블에서 최신 unread row 조회 (오늘 날짜 기준)
  - `markAlertRead(alertId)`: `read_at = now()` 업데이트
- [ ] `app/alerts/intraday/page.tsx` Server Component로 전환:
  - `getLatestAlert()` 호출 → 데이터 있으면 `IntradayAlertClient`에 전달
  - 데이터 없으면 "오늘 발동된 알림이 없습니다" 상태 표시
- [ ] `app/alerts/intraday/IntradayAlertClient.tsx` 신규 ("use client"):
  - `AlertMessage` 타입 기반으로 행동·금지·이유·미준수 리스크 렌더링
  - "읽음" 처리 (`markAlertRead` 호출)
  - 기존 목업 하드코딩 제거

**Verification:**
- [ ] DB에 alerts row가 있으면 실제 내용이 표시되는지 확인
- [ ] 없으면 빈 상태 메시지가 표시되는지 확인
- [ ] `npm run build` 성공

**Dependencies:** T001, T002, T003

**Likely Files:**
- `app/alerts/intraday/actions.ts` (신규)
- `app/alerts/intraday/page.tsx` (수정)
- `app/alerts/intraday/IntradayAlertClient.tsx` (신규)

**Estimated Scope:** M

---

## [ ] Task T006 — FR-035 승인·거절 이메일 통지

**Description:** 관리자가 신청을 승인하거나 거절하면 신청자에게 결과를 이메일로 통지한다. `lib/email.ts`를 재사용하고 alerts 테이블에 'approval' type으로 이력을 남긴다.

**Acceptance Criteria:**
- [ ] `app/admin/actions.ts`의 `approveApplication` 함수 수정:
  - 신청자 이메일 조회
  - 승인 이메일 발송: "스탁가드 이용이 승인되었습니다" 내용 + 서비스 진입 안내
  - alerts INSERT (`trigger_key: 'approval'`, `severity: 'medium'`, `is_sent: true`)
- [ ] `rejectApplication` 함수 수정:
  - 거절 이메일 발송: "이번에는 승인이 어렵습니다" + 거절 사유
  - alerts INSERT (`trigger_key: 'approval'`, `is_sent: true`)
- [ ] 이메일 발송 실패 시에도 승인/거절 상태 변경은 유지 (발송 실패는 경고 로그만)

**Verification:**
- [ ] 테스트 신청 승인 시 console 이메일 로그(RESEND 미설정 환경) 또는 실 이메일 수신 확인
- [ ] `npm run build` 성공

**Dependencies:** T001

**Likely Files:**
- `app/admin/actions.ts` (수정)

**Estimated Scope:** S

---

## [ ] Task T007 — 장중 시황 스케줄 API

**Description:** 하루 3회 전체 사용자에게 장중 시황 요약을 이메일로 발송하는 cron 엔드포인트를 구현한다. Vercel Cron 또는 외부 스케줄러로 호출 가능하다.

**Acceptance Criteria:**
- [ ] `app/api/cron/intraday/route.ts` GET 구현:
  - `CRON_SECRET` 환경 변수로 인증 (`Authorization: Bearer <CRON_SECRET>` 헤더 또는 `?secret=` 쿼리 파라미터)
  - 미설정/불일치 시 401 반환
  - 로직:
    1. `fetchMarketData()` 1회 호출
    2. 시황 요약 텍스트 생성 (규칙 기반 — 주요 지표 변화율 3줄 요약)
    3. `alert_channels`에서 `verified=true & consent_given=true`인 모든 email row 조회
    4. 각 사용자에게 시황 요약 이메일 발송 + alerts INSERT (`trigger_key: 'intraday_summary'`)
    5. 발송 건수 반환
- [ ] `vercel.json` 또는 README에 Cron 설정 예시 추가 (한국 시각 10:00/13:00/14:30 → UTC 01:00/04:00/05:30)
- [ ] `.env.example`에 `CRON_SECRET=` 이미 T001에서 추가됨 — 확인만

**Verification:**
- [ ] `curl /api/cron/intraday?secret=test` → 401 (secret 불일치)
- [ ] `CRON_SECRET=test` 설정 후 `?secret=test` → 200 + console 이메일 로그
- [ ] `npm run build` 성공

**Dependencies:** T001, T003

**Likely Files:**
- `app/api/cron/intraday/route.ts` (신규)
- `vercel.json` (신규 또는 수정)

**Estimated Scope:** S

---

## Checkpoint 2 — M4 최종

- [ ] T004~T007 완료
- [ ] 장중 체결 입력 → `/briefing` 재계산 동작 확인 (SC-004)
- [ ] `/alerts/intraday` 실데이터 표시 확인
- [ ] 관리자 승인 시 이메일 통지 (console 로그) 확인 (FR-035)
- [ ] `/api/cron/intraday` 인증 + 시황 발송 동작 확인 (FR-016)
- [ ] `npm run build` 에러 없음
- [ ] Supabase `alerts` 테이블에 데이터 확인
- [ ] 사용자 검토 가능 상태, M5 진행 전 승인 대기
