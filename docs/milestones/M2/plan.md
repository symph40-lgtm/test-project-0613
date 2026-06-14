# Plan: M2 — 포지션·원칙·설정 저장

## Overview

승인된 사용자가 첫 진입(`/onboarding`)에서 입력한 보유 종목, 위험선, 개인 매매 원칙, 알림 채널을
Supabase DB에 실제로 저장하고, 이후 모든 판단의 개인화 입력으로 활용할 수 있게 한다.

M1이 구축한 인증 세션과 `user_id`를 기반으로, 목업 더미 데이터를 실제 DB 데이터로 교체한다.

---

## Source Context

- **PRD FR-001** — 최대 10개 종목(이름·비중·레버리지 여부) 입력, 동일 종목 합산 처리
- **PRD FR-007** — 비중·손익률·레버리지·투자 기간 보완 입력 + 종목별 위험도 판단
- **PRD FR-008** — 종목 섹터 추천·판정 (반도체·2차전지·금융·방산 등)
- **PRD FR-009** — 전저점·급락률·시장 연동 기준 추천 위험선 제시 및 저장
- **PRD FR-010** — 개인 매매 원칙 선택·저장, 위험 상황 시 해당 원칙으로 알림
- **PRD FR-011** — 문자·이메일 알림 채널 입력·OTP 인증·수신 동의
- **PRD FR-015 (일부)** — 장중 체결 직접 입력 후 포지션 갱신

- **Roadmap M2 정의** — "positions/principles/alert_channels 테이블, 종목 CRUD(max 10), 섹터 자동 추천, 위험도 계산, 추천 위험선, 원칙 저장, OTP 채널 인증, 장중 체결 입력 후 포지션 갱신"

---

## Scope

- `positions`, `risk_lines`, `principles`, `alert_channels` DB 테이블 마이그레이션
- Row Level Security(RLS) 정책 (사용자 본인 데이터만 접근)
- 섹터 자동 추천 (서버 측 lookup 테이블, DB 아님)
- 종목별 위험도 계산 (규칙 기반 pure function)
- 추천 위험선 계산 로직 (비중·레버리지·급락률 기반 규칙)
- `/onboarding` → DB 저장 후 `/briefing` 이동
- `/positions` → 실제 DB 조회, 종목 추가·삭제, 손익률·섹터 보완 편집
- `/positions/risk-line` → 추천 위험선 계산 + 사용자 선택 DB 저장
- `/principles` → 실제 DB 저장·불러오기
- `/positions/risk-line` 알림 채널 섹션 → OTP 인증 흐름 (이메일 채널 완전 구현)
- `/positions/intraday` → 체결 로그 DB 저장 + positions 갱신

---

## Out of Scope

- 실시간 시세 연동 (M3)
- 장중 자동 알림 발송 (M4)
- SMS OTP 발송 (발송 서비스 미결정 — 아래 Open Questions 참고)
- 추천 위험선에 실제 현재가 반영 (M3)
- 섹터별 장세 단계 점수 계산 (M3)

---

## Functional Requirements Covered

| FR | 충족 방식 |
|----|----------|
| FR-001 | `/onboarding` 서버 액션이 positions 테이블에 upsert. 동일 ticker는 합산 여부 안내 |
| FR-007 | `positions` 테이블에 pnl·sector·risk_level 컬럼, 서버 사이드 위험도 계산 함수 |
| FR-008 | 서버 측 `getSectorHint(ticker)` lookup 함수, `/positions` 편집 UI에서 표시 |
| FR-009 | `risk_lines` 테이블, `recommendRiskLines(positions)` 규칙 함수, `/positions/risk-line` 저장 |
| FR-010 | `principles` 테이블, `savePrinciples` 서버 액션, `/principles` 실데이터 연결 |
| FR-011 | `alert_channels` 테이블, 이메일 OTP 생성·발송·검증 흐름, 수신 동의 컬럼 |
| FR-015 (일부) | `/positions/intraday` 체결 입력 → positions 테이블 weight 갱신 |

---

## Architecture / Implementation Approach

### DB 스키마

```
positions
  id, user_id (FK), ticker, name, weight (%), is_leverage, sector,
  pnl (%), risk_level ('취약'|'주의'|'안정'), created_at, updated_at
  UNIQUE(user_id, ticker)

risk_lines
  id, user_id (FK), trigger_key ('low'|'drop5'|'futures'|'rebound'), is_on
  UNIQUE(user_id, trigger_key)

principles
  id, user_id (FK), principle_key ('lev'|'avg'|'loan'|'gap'), is_on
  UNIQUE(user_id, principle_key)

alert_channels
  id, user_id (FK), channel_type ('email'|'sms'), contact,
  verified, consent_given, otp_code, otp_expires_at, updated_at
  UNIQUE(user_id, channel_type)
```

### RLS 정책 원칙

모든 테이블에 동일 패턴:
- `SELECT/INSERT/UPDATE/DELETE`: `auth.uid() = user_id`
- service role은 bypass (관리자 서버 액션에서 사용)

### 서버 로직 분리

```
lib/positions.ts       — getSectorHint(), calculateRiskLevel(), recommendRiskLines()
app/onboarding/        — savePositions() server action
app/positions/         — getPositions(), addPosition(), updatePosition(), deletePosition()
app/positions/risk-line/ — getRiskLines(), saveRiskLines(), startOtp(), verifyOtp()
app/principles/        — getPrinciples(), savePrinciples()
app/positions/intraday/ — saveFills(), applyFillsToPositions()
```

### 컴포넌트 구조 (M1 패턴 동일)

- Server Component(page.tsx)가 DB 조회 후 Client Component에 초기 데이터 전달
- Client Component("use client")가 `useTransition` + 서버 액션으로 상태 변경
- 변경 완료 후 `revalidatePath` 로 Server Component 재실행

### 섹터 추천 전략

서버 사이드 lookup 객체 (DB 아님):
- 주요 한국 종목 약 50개 + 미국 ETF/종목 약 30개
- 매칭 없으면 `null` 반환 → UI에서 "직접 입력" 처리
- M3 이후 외부 API로 업그레이드 가능

### 위험도 계산 규칙

```
레버리지 종목:
  weight ≥ 20 AND pnl ≤ -10  → '취약'
  weight ≥ 15 OR  pnl ≤ -5   → '주의'
  그 외                       → '안정'

일반 종목:
  weight ≥ 30 AND pnl ≤ -10  → '취약'
  pnl ≤ -5                   → '주의'
  그 외                       → '안정'
```

### 추천 위험선 로직

```
'low'     (전저점 이탈)    — weight > 10 이면 항상 추천
'drop5'   (장중 -5% 급락) — is_leverage 이면 추천
'futures' (선물 급락+금리) — is_leverage AND sector == '반도체' 이면 추천
'rebound' (반등 실패)      — weight > 20 AND risk_level == '취약' 이면 추천
```

실제 현재가/이동평균 반영은 M3에서 고도화.

### OTP 인증 흐름 (이메일)

1. 사용자가 이메일 입력 → `startOtpVerification('email', contact)` 서버 액션 호출
2. 서버: 6자리 OTP 생성, `alert_channels` 테이블에 otp_code + otp_expires_at(+10분) upsert
3. 서버: Supabase Auth Admin API (`inviteUserByEmail` 대신 `sendEmail`), 또는 Next.js API Route + Resend로 이메일 발송
4. 사용자가 코드 입력 → `verifyOtp('email', code)` 서버 액션 호출
5. 서버: otp_code 일치 + expires_at 미만 확인 → `verified = true` 갱신

> **이메일 발송 방법**: 단순히 Supabase SMTP 설정이 이미 되어있으므로 `supabase.auth.admin.generateLink()` 를 이용하거나, Next.js API Route에서 `nodemailer` / `Resend` SDK 를 사용한다. 프로젝트에 이미 설정된 방법 우선.

---

## Dependency Graph

```
supabase/migrations/003_positions.sql
  └─ lib/positions.ts (getSectorHint, calculateRiskLevel, recommendRiskLines)
      └─ app/onboarding/actions.ts (savePositions)
          └─ app/onboarding/page.tsx (DB 연결)
      └─ app/positions/actions.ts (CRUD)
          └─ app/positions/page.tsx + PositionsClient.tsx
              └─ [Checkpoint 1]

supabase/migrations/004_risk_lines.sql
  └─ app/positions/risk-line/actions.ts (getRiskLines, saveRiskLines)
      └─ app/positions/risk-line/page.tsx (DB 연결)
          └─ [Checkpoint 2]

supabase/migrations/005_principles.sql
  └─ app/principles/actions.ts (savePrinciples, getPrinciples)
      └─ app/principles/page.tsx (DB 연결)
          └─ [Checkpoint 3]

supabase/migrations/006_alert_channels.sql
  └─ app/positions/risk-line/alert-actions.ts (startOtp, verifyOtp)
      └─ app/positions/risk-line/page.tsx (알림 채널 섹션 업데이트)
          └─ [Checkpoint 4]

app/positions/actions.ts (updatePosition weight)
  └─ app/positions/intraday/actions.ts (saveFills, applyFills)
      └─ app/positions/intraday/page.tsx (DB 연결)
```

---

## Verification Strategy

- `npm run build` 에러 없음
- `/onboarding` 에서 종목 입력 후 "오늘 판단 보기" → Supabase Table Editor에서 positions 행 확인
- `/positions` 에서 실제 저장된 종목 목록 표시, 추가·삭제 동작
- `/positions/risk-line` 에서 추천 위험선 표시 + 저장 → DB에 risk_lines 행 확인
- `/principles` 에서 원칙 선택·저장 → DB에 principles 행 확인
- 이메일 OTP: 인증 메일 수신 확인 → 코드 입력 → `alert_channels.verified = true` 확인
- `/positions/intraday` 에서 체결 입력 → positions 테이블 weight 변경 확인

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| 이메일 발송 서비스 미설정 | 이메일 OTP 불가 | Supabase Dashboard > Auth > SMTP 설정 확인; 없으면 console.log로 OTP 출력(개발용) |
| SMS 발송 서비스 미결정 | SMS 채널 인증 불가 | M2에서는 UI와 DB만 구현, 실제 발송은 M4 SMS 서비스 결정 후 추가 |
| 섹터 lookup 미매칭 종목 많음 | 섹터 추천 실패 | null 반환 시 UI에서 빈 입력 허용, 사용자가 직접 입력 가능 |
| /onboarding 재방문 시 기존 positions 덮어쓰기 | 데이터 손실 | UPSERT + 기존 데이터 로드 후 표시. 첫 방문 여부는 positions 테이블 row count로 판단 |
| risk_lines가 positions와 uncoupled | 포지션 삭제 시 orphan risk_line | user_id 기반 global 트리거 방식이라 orphan 문제 없음; 단 추천 로직에서 현재 positions 기반 재계산 |

---

## Open Questions

1. **SMS OTP 서비스**: Twilio / AWS SNS / 알리고 등 어떤 서비스를 사용할지 미결정. → M2에서는 이메일만 완전 구현, SMS UI·DB는 준비하고 발송은 TODO. M4 전에 결정 필요.
2. **이메일 발송 방법**: Supabase SMTP 기본 설정이 있으면 사용, 없으면 Resend 또는 console.log fallback. → T006 시작 전 `RESEND_API_KEY` 또는 Supabase SMTP 설정 확인 필요.
3. **손익률(pnl) 초기값**: `/onboarding` 에서는 pnl 입력 없음. positions 테이블에 null로 저장하고, `/positions` 에서 보완 입력. 위험도 계산에서 pnl=null은 0으로 처리.
