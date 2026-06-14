# Plan: M6 — 개인화 인사이트 & 오판 분석

## Overview

누적된 행동 기록(`action_logs`)과 브리핑 판단 이력(`briefing_snapshots`)을 기반으로 AI가 개인화 인사이트와 오판 분석 리포트를 생성한다. 사용자가 개인화 학습 반영 여부를 제어하고 기록을 삭제·초기화할 수 있다. 마감 전 "내일 아침 다시 보기" 예약도 실제로 저장되어 다음날 브리핑에서 알림으로 표시된다.

## Source Context

- **PRD FR-026:** 오판 분석 리포트 — 당시 근거 + 이후 바뀐 변수 분리 + 다음 반영안 (LLM 생성)
- **PRD FR-027:** 개인화 인사이트 — 반복 실수·잘 맞는 판단 조건·취약 장세 요약 (LLM 생성)
- **PRD FR-028:** 개인화 반영 동의 ON/OFF, 특정 기록 제외, 전체 삭제·초기화
- **PRD FR-038:** "내일 아침 다시 보기" 예약 저장 → 다음날 브리핑 접속 시 예약 알림 표시
- **Roadmap M6 Scope:** `personalization_settings` 테이블, LLM 인사이트·오판 생성, 학습 제어, "내일 아침" 예약
- **M5 의존:** `action_logs`가 쌓여야 의미 있는 인사이트/오판 분석 가능

## Scope

1. `personalization_settings` 테이블 (user_id 기준, enabled ON/OFF, excluded_log_ids 목록)
2. `briefing_bookmarks` 테이블 ("내일 아침" 예약 저장)
3. 개인화 인사이트 LLM 생성 + `/journal/insights` 실데이터 연결
   - action_logs (excluded 제외) 기반 → strong·weak·reinforce 생성
   - ANTHROPIC_API_KEY 없으면 rule-based fallback
4. 개인화 반영 ON/OFF 저장 + 특정 기록 제외 + 전체 삭제·초기화
5. 오판 분석 LLM 생성 + `/journal/misjudgment` 실데이터 연결
   - 가장 최근의 "따르지 않음 + 손실" 기록 → basisThen·changed·cause·nextApply 생성
   - "이번 사례 제외" → excluded_log_ids에 추가
6. FR-038: PrecloseClient 예약 버튼 실DB 연결 + 브리핑 화면 예약 알림 배너

## Out of Scope

- 서비스 전체 모델 파인튜닝 파이프라인 (비범위)
- 외부 활용·공유 기능 (비범위)
- 버핏 외 투자 대가 보조 관점 (비범위)
- 개인정보 보관·삭제 법적 처리 (운영 정책 미정)

## Functional Requirements Covered

| FR | 충족 방식 |
|----|---------|
| FR-026 | 오판 분석 LLM 생성 (당시 근거·바뀐 변수·원인·다음 반영안) + /journal/misjudgment 실데이터 |
| FR-027 | 개인화 인사이트 LLM 생성 (잘 맞은 판단·취약 조건·강화 항목) + /journal/insights 실데이터 |
| FR-028 | personalization_settings: ON/OFF 토글, excluded_log_ids 제외, 전체 삭제·초기화 |
| FR-038 | briefing_bookmarks: 예약 저장 → 다음날 브리핑에서 알림 배너 |

## Architecture / Implementation Approach

### 데이터 흐름

```
action_logs (M5)
  └─ personalization_settings.excluded_log_ids (필터)
      └─ LLM 인사이트 생성 → /journal/insights
      └─ 오판 분석 대상 선정 → LLM → /journal/misjudgment
          └─ "이번 사례 제외" → excluded_log_ids 업데이트

briefing_bookmarks
  └─ PrecloseClient 예약 버튼 → INSERT
      └─ BriefingClient 페이지 로드 → 전날 예약 확인 → 알림 배너
```

### personalization_settings 스키마

| 컬럼 | 타입 | 설명 |
|------|------|------|
| user_id | uuid (PK) | FK → auth.users |
| personalization_enabled | boolean | 개인화 반영 ON/OFF (default true) |
| excluded_log_ids | uuid[] | 학습 제외된 action_log id 목록 |
| updated_at | timestamptz | |

### briefing_bookmarks 스키마

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | uuid (PK) | |
| user_id | uuid | FK → auth.users |
| scheduled_date | date | 예약 날짜 (내일 = 마감 전 판단일 + 1) |
| created_at | timestamptz | |

### LLM 인사이트 생성 (FR-027)

- 모델: `claude-haiku-4-5` (M3·M4와 동일)
- 입력: action_logs 최근 30건 (excluded_log_ids 제외, personalization_enabled=true인 경우만)
- 출력 JSON: `{ strong: string, weak: string, reinforce: string[] }`
- Fallback (API 키 없음 또는 기록 3건 미만): rule-based 메시지 ("기록이 더 쌓이면 인사이트를 생성합니다")

### LLM 오판 분석 생성 (FR-026)

- 오판 대상 선정: `follow_level='따르지 않음' AND result_day1 < 0 AND id NOT IN excluded_log_ids` → 가장 최근 1건
- briefing_snapshot 연결: `briefing_snapshot_id`로 당시 ai_output 조회 (없으면 guidance_action/prohibition 사용)
- 출력 JSON: `{ verdict, result, basisThen: string[], changed: string[], cause: string, nextApply: string }`
- Fallback: 오판 대상 없으면 "아직 분석할 오판 사례가 없습니다" 빈 상태

### 화면 패턴

M3~M5와 동일: Server Component (데이터 조회) → Client Component ("use client", 상태 관리)

## Dependency Graph

```
010_personalization.sql (T001)
  └─ app/journal/insights/actions.ts (T002)
      └─ app/journal/insights/page.tsx + InsightsClient.tsx (T002)
          └─ app/journal/misjudgment/actions.ts (T003)
              └─ app/journal/misjudgment/page.tsx + MisjudgmentClient.tsx (T003)
                  └─ app/briefing/preclose/actions.ts + PrecloseClient 수정 (T004)
                      └─ app/briefing/actions.ts + BriefingClient 수정 (T004)
```

## Verification Strategy

- 각 태스크: `npm run build` 타입 체크 통과
- T002: 기록 3건 이상 시 인사이트가 실제로 표시되는지 확인 (ANTHROPIC_API_KEY 미설정 → fallback 확인)
- T003: follow_level='따르지 않음' + result_day1 < 0 기록이 있을 때 오판 분석 표시 확인
- T004: 마감 전 판단에서 예약 후 다음날 브리핑에서 알림 배너 확인

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| action_logs 기록 부족으로 인사이트 품질 저하 | 중 | 3건 미만 시 LLM 미호출 + fallback 메시지 표시 |
| briefing_snapshot 연결이 없는 오판 기록 | 낮 | snapshot 없으면 guidance_action/prohibition으로 대체 |
| excluded_log_ids uuid[] 타입 Supabase 쿼리 | 낮 | `.not('id', 'in', `(${ids.join(',')})`)` 또는 JS 필터로 처리 |
| FR-038 예약이 다음날 브리핑보다 늦게 접속될 경우 | 낮 | scheduled_date 기준 ±0일로 확인, 읽으면 read_at 기록 |

## Open Questions

없음 — 모든 설계 결정이 M3~M5 패턴과 일관성 있게 확정됨.
