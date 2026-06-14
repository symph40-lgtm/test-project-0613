# Tasks: M2 — 포지션·원칙·설정 저장

---

## [x] Task T001 — positions DB 마이그레이션

**Description:** `positions` 테이블을 생성하고 RLS 정책을 적용한다.

**Acceptance Criteria:**
- [ ] `positions` 테이블 생성 (`id`, `user_id`, `ticker`, `name`, `weight`, `is_leverage`, `sector`, `pnl`, `risk_level`, `created_at`, `updated_at`)
- [ ] `UNIQUE(user_id, ticker)` 제약 조건 적용
- [ ] `updated_at` 자동 갱신 트리거 (M1의 applications와 동일 패턴)
- [ ] RLS 활성화: `auth.uid() = user_id` 로 SELECT/INSERT/UPDATE/DELETE 허용
- [ ] Supabase SQL Editor에서 실행 성공

**Verification:**
- [ ] Supabase Table Editor에서 `positions` 테이블 확인
- [ ] 현재 인증된 사용자 계정으로 테이블에 row 직접 삽입 성공

**Dependencies:** 없음 (M1 완료 상태)

**Likely Files:**
- `supabase/migrations/003_positions.sql` (신규)

**Estimated Scope:** XS

---

## [x] Task T002 — 섹터 추천·위험도 계산 로직 + /onboarding DB 연결

**Description:** 섹터 lookup 함수와 위험도 계산 pure function을 작성하고, `/onboarding` 에서 종목을 positions 테이블에 저장하는 서버 액션을 구현한다.

**Acceptance Criteria:**
- [ ] `lib/positions.ts` 에 `getSectorHint(ticker: string): string | null` 구현 (주요 한국·미국 종목 50+ 커버)
- [ ] `lib/positions.ts` 에 `calculateRiskLevel({ weight, is_leverage, pnl }): '취약'|'주의'|'안정'` 구현
- [ ] `app/onboarding/actions.ts` 에 `savePositions(prevState, formData)` 서버 액션 구현
  - 최대 10개 검증
  - `UPSERT` (동일 ticker는 기존 row 업데이트)
  - 섹터 자동 추천 후 저장
  - 위험도 계산 후 저장
  - 저장 완료 후 `/briefing` redirect
- [ ] `/onboarding/page.tsx` 에서 기존 in-memory 더미 데이터 대신 서버 액션 연결
  - 로그인한 사용자의 기존 positions를 초기 상태로 로드 (재방문 시 유지)
  - "오늘 판단 보기" 클릭 시 DB 저장 → redirect

**Verification:**
- [ ] `/onboarding` 에서 종목 3개 입력 → 버튼 클릭 → `/briefing` 이동
- [ ] Supabase Table Editor > positions 에서 저장된 3개 row 확인
- [ ] `ticker`별 `sector`, `risk_level` 컬럼에 값이 채워진 것 확인
- [ ] 재방문 시 기존 종목이 초기 상태로 표시되는 것 확인
- [ ] `npm run build` 성공

**Dependencies:** T001

**Likely Files:**
- `lib/positions.ts` (신규)
- `app/onboarding/actions.ts` (신규)
- `app/onboarding/page.tsx` (수정)

**Estimated Scope:** M

---

## [x] Task T003 — /positions 실제 DB 조회 + 종목 편집

**Description:** `/positions` 페이지를 실제 DB 데이터로 연결한다. 목업 데이터 제거, Server Component + Client Component 분리, 종목 추가·삭제·손익률 보완 편집 구현.

**Acceptance Criteria:**
- [ ] `app/positions/actions.ts` 에 `getPositions()`, `addPosition()`, `updatePosition()`, `deletePosition()` 서버 액션 구현
  - 레버리지/비중/손익률 변경 시 `risk_level` 재계산 후 저장
- [ ] `app/positions/page.tsx` → async Server Component로 변환 (DB에서 positions 조회)
- [ ] `app/positions/PositionsClient.tsx` 신규 생성 ("use client", `useTransition`)
  - 테이블·카드 UI 유지
  - 종목 추가 버튼: 인라인 입력 행 추가 → 저장
  - 행 클릭 → 손익률·섹터 편집 인라인 또는 모달
  - 삭제 버튼
  - 추가/삭제/편집 후 optimistic update 또는 `revalidatePath`
- [ ] 목업 `app/_data/mock.ts`의 positions seed는 positions 페이지에서 더 이상 사용하지 않음

**Verification:**
- [ ] `/positions` 에서 T002에서 저장한 종목 목록이 실제 표시됨
- [ ] 종목 손익률 편집 → DB 반영 → risk_level 변경 확인
- [ ] 종목 추가 → DB에 row 생성 확인
- [ ] 종목 삭제 → DB에서 row 삭제 확인
- [ ] 10개 초과 추가 시 "최대 10개" 안내 표시

**Dependencies:** T001, T002

**Likely Files:**
- `app/positions/actions.ts` (신규)
- `app/positions/page.tsx` (수정)
- `app/positions/PositionsClient.tsx` (신규)

**Estimated Scope:** M

---

## Checkpoint 1 — 포지션 저장 흐름 완전 동작

- [ ] T001, T002, T003 완료
- [ ] `/onboarding` → positions 저장 → `/briefing` 이동
- [ ] `/positions` 에서 실제 DB 데이터 조회·편집 동작
- [ ] `npm run build` 성공
- [ ] 사용자 검토 가능 상태

---

## [x] Task T004 — risk_lines DB 마이그레이션 + 위험선 추천·저장

**Description:** `risk_lines` 테이블을 생성하고, 추천 위험선 계산 로직을 구현하며, `/positions/risk-line` 을 실제 DB에 연결한다.

**Acceptance Criteria:**
- [ ] `supabase/migrations/004_risk_lines.sql` 작성·실행 성공
  - 컬럼: `id`, `user_id`, `trigger_key` ('low'|'drop5'|'futures'|'rebound'), `is_on`
  - UNIQUE(user_id, trigger_key), RLS 적용
- [ ] `lib/positions.ts` 에 `recommendRiskLines(positions: Position[]): string[]` 구현
  - 현재 positions 기반으로 추천 trigger_key 목록 반환
  - 계획서 "추천 위험선 로직" 규칙 적용
- [ ] `app/positions/risk-line/actions.ts` 에 `getRiskLines()`, `saveRiskLines(selections)` 서버 액션 구현
- [ ] `app/positions/risk-line/page.tsx` 업데이트
  - 목업 `riskLines` 데이터 제거, 실제 DB + 추천 로직 사용
  - Server Component로 변환 (positions + risk_lines 조회)
  - 현재 장세 표시 부분은 mock 유지 (M3에서 실데이터로 교체)
  - 추천된 항목은 별도 표시 (예: "추천" 배지)
  - "적용하기" 클릭 → `saveRiskLines` 호출 → DB 저장 → `/principles` 이동

**Verification:**
- [ ] `/positions/risk-line` 에서 추천 항목이 계산 규칙에 따라 표시됨
- [ ] "적용하기" 클릭 → Supabase Table Editor > risk_lines 에서 선택된 trigger_key rows 확인
- [ ] 재방문 시 이전 선택 상태가 복원됨
- [ ] `npm run build` 성공

**Dependencies:** T001, T003

**Likely Files:**
- `supabase/migrations/004_risk_lines.sql` (신규)
- `lib/positions.ts` (수정)
- `app/positions/risk-line/actions.ts` (신규)
- `app/positions/risk-line/page.tsx` (수정)

**Estimated Scope:** M

---

## Checkpoint 2 — 위험선 추천·저장 동작

- [ ] T004 완료
- [ ] `/positions/risk-line` 에서 추천 위험선 계산 → 선택 → DB 저장 전체 흐름 동작
- [ ] `npm run build` 성공

---

## [x] Task T005 — principles DB 마이그레이션 + /principles DB 연결

**Description:** `principles` 테이블을 생성하고 `/principles` 를 실제 DB에 연결한다.

**Acceptance Criteria:**
- [ ] `supabase/migrations/005_principles.sql` 작성·실행 성공
  - 컬럼: `id`, `user_id`, `principle_key` ('lev'|'avg'|'loan'|'gap'), `is_on`
  - UNIQUE(user_id, principle_key), RLS 적용
- [ ] `app/principles/actions.ts` 에 `getPrinciples()`, `savePrinciples(selections)` 서버 액션 구현
  - `savePrinciples`: 선택된 키 목록을 UPSERT (is_on=true/false)
- [ ] `app/principles/page.tsx` 업데이트
  - 목업 `principles` 시드 제거, 실제 DB 조회
  - Server Component로 변환 (principles 조회 후 클라이언트에 전달)
  - Client Component에서 토글·저장 처리 (`useTransition`)
  - `active` 상태 (현재 해당 원칙) 표시는 mock 유지 (M4에서 실시간 연동)
  - "저장하기" 클릭 → `savePrinciples` → `/briefing` 이동

**Verification:**
- [ ] `/principles` 에서 원칙 3개 선택 → 저장 → Supabase Table Editor > principles 확인
- [ ] 재방문 시 이전 선택 상태 복원
- [ ] `npm run build` 성공

**Dependencies:** T001 (user_id 기반)

**Likely Files:**
- `supabase/migrations/005_principles.sql` (신규)
- `app/principles/actions.ts` (신규)
- `app/principles/page.tsx` (수정)

**Estimated Scope:** S

---

## Checkpoint 3 — 원칙 저장 흐름 동작

- [ ] T005 완료
- [ ] `/principles` 에서 원칙 선택·저장 → DB 반영 전체 흐름 동작
- [ ] `npm run build` 성공

---

## [x] Task T006 — alert_channels DB + 이메일 OTP 인증 흐름

**Description:** `alert_channels` 테이블을 생성하고, `/positions/risk-line` 의 알림 채널 섹션에 실제 OTP 인증 흐름을 구현한다. 이메일 채널 완전 구현, SMS 채널은 DB + UI만 준비 (발송 deferred).

**Acceptance Criteria:**
- [ ] `supabase/migrations/006_alert_channels.sql` 작성·실행 성공
  - 컬럼: `id`, `user_id`, `channel_type` ('email'|'sms'), `contact`, `verified`, `consent_given`, `otp_code`, `otp_expires_at`, `updated_at`
  - UNIQUE(user_id, channel_type), RLS 적용
- [ ] `app/positions/risk-line/alert-actions.ts` 에 서버 액션 구현:
  - `saveChannel(channelType, contact)` — DB upsert (미인증 상태)
  - `startOtpVerification(channelType, contact)` — 6자리 OTP 생성, DB 저장, 이메일 발송 (SMS는 console.log + "서비스 준비 중" 안내)
  - `verifyOtp(channelType, code)` — OTP 검증, 만료 확인, `verified = true` 갱신
  - `saveConsent(channelType)` — `consent_given = true` 갱신
- [ ] 이메일 발송: Next.js API Route 또는 서버 액션에서 Resend SDK 또는 Supabase SMTP 사용. 발송 불가 환경에서는 console.log로 OTP 출력 (개발 fallback)
- [ ] `/positions/risk-line/page.tsx` 의 `ChannelRow` 컴포넌트 업데이트:
  - 연락처 입력 → "인증 요청" 버튼 → OTP 입력 필드 표시 → 코드 입력 → "확인" → 인증 완료 상태 표시
  - 수신 동의 체크박스 (consent_given)
  - SMS는 "서비스 준비 중" 표시 또는 입력 비활성화
  - 기존 `verified` 상태는 DB에서 로드

**Verification:**
- [ ] 이메일 입력 → "인증 요청" → 이메일 수신 (또는 console.log에서 OTP 확인)
- [ ] OTP 코드 입력 → "확인" → `alert_channels.verified = true` 확인
- [ ] 만료된 OTP 입력 시 에러 메시지 표시
- [ ] 잘못된 OTP 입력 시 에러 메시지 표시
- [ ] SMS 채널: "서비스 준비 중" 또는 비활성화 안내 표시
- [ ] `npm run build` 성공

**Dependencies:** T001 (user_id), T004 (risk-line 페이지 구조)

**Likely Files:**
- `supabase/migrations/006_alert_channels.sql` (신규)
- `app/positions/risk-line/alert-actions.ts` (신규)
- `app/positions/risk-line/page.tsx` (수정)

**Estimated Scope:** M

---

## [x] Task T007 — /positions/intraday DB 연결

**Description:** `/positions/intraday` 에서 입력한 체결을 DB에 저장하고, positions 테이블의 weight를 갱신한다.

**Acceptance Criteria:**
- [ ] `app/positions/intraday/actions.ts` 에 `applyFills(fills)` 서버 액션 구현:
  - fills 배열 (type: '매도'|'매수'|'신규', ticker, detail) 입력
  - `신규` fill → positions에 insert (weight는 detail에서 숫자 파싱, is_leverage는 기본 false)
  - `매도` fill → 해당 ticker의 weight를 사용자 입력값으로 갱신 (또는 "0"이면 삭제)
  - `매수` fill → 해당 ticker의 weight를 사용자 입력값으로 갱신
  - detail 파싱 실패 시 positions 수정 없이 저장만 (raw log 유지)
  - 갱신 후 risk_level 재계산
  - 완료 후 `/briefing` redirect
- [ ] `/positions/intraday/page.tsx` 업데이트:
  - "최신 상태로 다시 판단" 클릭 → `applyFills` 서버 액션 호출
  - "변경 후 주요 포지션" 프리뷰 섹션: 변경 후 positions를 DB에서 조회해 표시
  - 목업 `afterPositions` 더미 데이터 제거

**Verification:**
- [ ] `/positions/intraday` 에서 기존 종목 매도 입력 → 제출 → `/briefing` 이동
- [ ] Supabase Table Editor > positions 에서 weight 변경 확인
- [ ] 신규 종목 입력 → positions에 새 row 생성 확인
- [ ] `npm run build` 성공

**Dependencies:** T001, T003

**Likely Files:**
- `app/positions/intraday/actions.ts` (신규)
- `app/positions/intraday/page.tsx` (수정)

**Estimated Scope:** S

---

## Checkpoint 4 — M2 최종

- [ ] T006, T007 완료
- [ ] 전체 흐름 검증:
  - `/onboarding` → positions 저장 → `/positions` 조회 → `/positions/risk-line` 위험선 적용 + 이메일 인증 → `/principles` 원칙 저장 → `/briefing`
  - `/positions/intraday` → 체결 입력 → positions 갱신 → `/briefing`
- [ ] `npm run build` 에러 없음
- [ ] Supabase Table Editor에서 4개 테이블 (positions, risk_lines, principles, alert_channels) 모두 데이터 확인
- [ ] 사용자 검토 가능 상태, M3 진행 전 승인 대기
