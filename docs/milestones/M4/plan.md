# Plan: M4 - 장중 알림 & 마감 전 판단

## Overview

장중 실시간 시장 변화를 평가해 위험 조건이 충족되면 이메일 알림을 발송하고, 장중 체결 반영 후 재판단 흐름을 완성한다. 승인·거절 결과 통지(FR-035)와 장중 시황 스케줄 API도 구현한다. 마감 전 판단은 M3에서 Claude 연동이 완료되어 있으므로 알림 트리거와 발송 인프라 연결이 핵심이다.

## Source Context

- **PRD FR-012**: 장중 위험 조건(위험선 도달·급락·금리 급등·섹터 급락)이 닿으면 원칙 기반 알림 발송
- **PRD FR-013**: 알림 = 행동·금지·이유 + 미준수 리스크(원인→취약 종목→손실 결과→확인할 지표)
- **PRD FR-014**: 레버리지·급락 조건을 최우선 강도로 분류
- **PRD FR-015**: 장중 체결 입력 → 포지션 갱신 → AI 재판단 (SC-004)
- **PRD FR-016**: 하루 3회 장중 시황 요약 발송 (문자 → MVP에서는 이메일)
- **PRD FR-017~019**: 마감 전 종목별 판단 (M3에서 이미 Claude 연동 완료)
- **PRD FR-035**: 승인·거절 결과 신청자 외부 통지
- **Roadmap M4**: SMS는 비범위(SMS 준비 중) — 이메일로 대체. 카카오 알림톡도 비범위.

## Scope

1. **DB**: `alerts` 테이블 (알림 이력·발송 상태·읽음 확인)
2. **알림 트리거 평가** `lib/alerts/triggers.ts`: 저장된 risk_lines + 현재 시장 데이터 → 발동 조건 평가 + 강도 분류
3. **알림 메시지 생성** `lib/alerts/compose.ts`: FR-013 형식(행동·금지·이유·미준수 리스크)
4. **이메일 발송** `app/api/alerts/send/route.ts`: 평가 → 생성 → 발송 → DB 저장 (Resend/console fallback)
5. **장중 체결 → 재판단**: `applyFills` 완료 후 오늘의 `briefing_snapshots` 캐시 삭제 → 재방문 시 자동 재계산
6. **장중 알림 화면** `/alerts/intraday`: DB에서 최근 발생한 알림 실데이터 표시
7. **FR-035 승인·거절 통지**: 관리자 승인/거절 시 신청자에게 이메일 발송
8. **장중 시황 API** `app/api/cron/intraday/route.ts`: Vercel Cron 또는 외부 scheduler 호출 → 전체 사용자 시황 발송

## Out of Scope

- SMS 실제 발송 (서비스 준비 중 유지 — 인프라 미선정)
- 카카오 알림톡
- WebSocket / Server-Sent Events 기반 실시간 Push
- 자동 주문·매매 실행
- M3에서 이미 구현된 마감 전 판단 화면 재작업 (Claude 생성 결과가 이미 표시됨)

## Functional Requirements Covered

| FR | 구현 방식 |
|----|---------|
| FR-012 | 알림 트리거 평가 API + 이메일 발송 |
| FR-013 | compose.ts — 행동·금지·이유·미준수 리스크 4단계 포맷 |
| FR-014 | 레버리지 포지션 + drop5/futures 조건 → severity: 'high' 우선 분류 |
| FR-015 | applyFills 후 briefing_snapshots 오늘 row 삭제 → 재판단 |
| FR-016 | /api/cron/intraday 스케줄 API (이메일 기반) |
| FR-017~019 | M3에서 구현 완료 — M4에서는 마감 전 판단 화면에 "알림 이력 연결" 추가 |
| FR-035 | admin actions approve/reject 시 sendEmail 호출 |

## Architecture / Implementation Approach

### 알림 평가 흐름

```
[cron / page load] → /api/alerts/send
  → fetchMarketData()
  → evaluateAlertTriggers(market, positions, riskLines)  // pure function
  → [trigger 있으면] composeAlertMessage(trigger, principles)
  → sendEmail()
  → alerts row INSERT
```

### 트리거 평가 규칙 (`lib/alerts/triggers.ts`)

저장된 `risk_lines` 테이블의 4개 trigger_key를 평가한다:

| trigger_key | 발동 조건 (market data 기준) | 기본 강도 |
|-------------|---------------------------|---------|
| `low` | KOSPI 또는 SOX `changePercent < -2%` | medium |
| `drop5` | 나스닥 또는 SOX `changePercent < -5%` | high |
| `futures` | 나스닥 `changePercent < -3%` AND 10Y 금리 당일 상승(+) | high |
| `rebound` | 나스닥 전일 대비 반등(+) BUT 복합 리스크 점수 ≥ 60 | medium |

레버리지 포지션이 있는 사용자의 high 트리거 → `severity: 'high'` 우선 전달.

### 캐시 무효화 방식

`applyFills` 완료 후:
```ts
// 오늘 날짜의 briefing_snapshots row 삭제 → 재방문 시 getBriefing()가 재계산
await supabase
  .from("briefing_snapshots")
  .delete()
  .eq("user_id", user.id)
  .eq("date", today);
```

### 알림 메시지 포맷 (FR-013)

```
[행동] {action}
[금지] {prohibition}
[이유] {reasons}
[무시하면 생길 수 있는 리스크]
  1. 원인: {cause}
  2. 취약 종목: {vulnerableTicker}
  3. 손실 결과: {lossOutcome}
  4. 확인할 지표: {indicatorsToCheck}
```

### 스케줄 API

- `GET /api/cron/intraday?secret=CRON_SECRET`  
- `CRON_SECRET` 환경 변수로 보호  
- 오전 10:00, 오후 1:00, 오후 2:30 (3회) — Vercel Cron 설정 또는 외부 호출  
- 전체 활성 사용자(알림 채널 verified=true)에 대해 시황 요약 이메일 발송

## Dependency Graph

```
008_alerts.sql (DB)
  └── lib/alerts/triggers.ts (평가 로직)
        └── lib/alerts/compose.ts (메시지 생성)
              └── app/api/alerts/send/route.ts (발송 API)
                    ├── app/alerts/intraday/page.tsx (알림 화면 실데이터)
                    └── app/api/cron/intraday/route.ts (스케줄)

lib/supabase/server.ts (기존)
  └── app/positions/intraday/actions.ts (캐시 무효화 추가)

app/admin/actions.ts (기존)
  └── FR-035 이메일 통지 추가
```

## Verification Strategy

- `npm run build` 성공 확인
- `/api/alerts/send` 수동 POST → DB에 alerts row 생성 + console 이메일 로그 확인
- `/positions/intraday`에서 체결 입력 후 `/briefing`이 갱신된 포지션 기준으로 재계산되는지 확인
- `/admin/applications`에서 승인 시 신청자 이메일(또는 console 로그)로 통지 확인
- `/alerts/intraday`에서 최근 알림 실데이터 표시 확인

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| 실제 SMS 불가 | FR-016 이메일 대체 | SMS row에 "서비스 준비 중" 반환 유지 |
| Yahoo Finance 장중 데이터 지연 | 알림 트리거 지연 | 최선 노력(best effort) — 알림 TDD 보장 어려움 명시 |
| CRON_SECRET 미설정 | cron 엔드포인트 노출 | 환경 변수 없으면 401 반환 |
| briefing cache 삭제 후 재계산 지연 | 사용자 UX | 재판단 로딩 상태(스피너) 표시 |
| 알림 중복 발송 | 사용자 불편 | alerts 테이블에서 오늘 이미 발송된 trigger_key 확인 후 skip |

## Open Questions

- Vercel Cron 사용 여부 (배포 플랫폼이 Vercel인지 확인 필요)
- 장중 알림 쿨다운 정책: 같은 trigger_key는 하루 1회만 발송? 또는 24시간 쿨다운?
- FR-016 시황 요약 발송 시각 (10:00/13:00/14:30 한국시각 기준)
