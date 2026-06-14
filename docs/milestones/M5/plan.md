# Plan: M5 — 행동 기록 & 갭 리포트

## Overview

사용자가 날짜·종목별로 스탁가드 안내와 실제 행동·결과를 DB에 저장하면, 준수 비율·반복 패턴을 판단 갭 리포트로 실제 데이터 기반으로 확인할 수 있게 한다. 유사 상황 회상도 실제 기록 데이터 기반으로 작동한다.

매매가 지나간 뒤 기억에 의존해 후회하는 사용자가 "안내를 따랐을 때와 따르지 않았을 때의 결과 차이"를 객관적 데이터로 확인하는 것이 핵심 가치다.

## Source Context

- **PRD FR-023:** 날짜·종목별 안내/행동/따름 여부/이유/결과(당일·다음날·3거래일·1주일)를 같은 타임라인에 기록
- **PRD FR-024:** 준수 vs 미준수 결과 차이, 미준수 후 수익·손실 사례 분리 — 판단 갭 리포트
- **PRD FR-025:** 현재 장세·종목·섹터 조건과 과거 `action_logs` 매칭 — 유사 상황 회상
- **SC-005:** 1건 이상 기록 시 준수 비율·반복 패턴 요약 표시. 소표본(5건 미만) 시 신뢰도 경고 병기
- **Roadmap M5 Scope:** `action_logs` 테이블 설계·마이그레이션, 기록 입력 서버 액션, 갭 리포트 계산, 유사 상황 매칭. M3의 `briefing_snapshots`와 조인해 안내 내용 연결

## Scope

1. `action_logs` 테이블 설계 및 마이그레이션 (009번)
2. 행동 기록 입력 서버 액션 + `/journal` 화면 실데이터 연결
   - 오늘 브리핑 안내(action·prohibition) 자동 조회 (briefing_snapshots 연결)
   - 실제 행동·따름 여부·이유·결과(4개 시점) 저장
3. 판단 갭 리포트 계산 로직 + `/journal/gap-report` 실데이터 연결
   - 준수 비율 (따름/일부 따름/따르지 않음 각 건수)
   - 미준수 후 수익 사례 / 손실 사례 분리 집계
   - 반복 패턴 추출 (stage + follow_level 조합 중 가장 많은 패턴)
   - 소표본(총 5건 미만) 경고
4. 유사 상황 회상 매칭 로직 + `/journal/similar` 실데이터 연결
   - 현재 브리핑 stage + 현재 포지션 ticker와 과거 기록 매칭
   - 가장 조건이 많이 겹치는 과거 사례 1건 표시

## Out of Scope

- 오판 분석 리포트 (M6)
- 개인화 인사이트 AI 생성 (M6)
- 결과 가격 자동 계산 (증권 연동 비범위)
- `/journal/insights`, `/journal/misjudgment` 실데이터 연결 (M6)

## Functional Requirements Covered

| FR | 충족 방식 |
|----|---------|
| FR-023 | action_logs 테이블 저장 + /journal 입력 화면 서버 액션 |
| FR-024 | 갭 리포트 집계 로직 (준수 비율·미준수 수익/손실 분리) + /journal/gap-report 실데이터 |
| FR-025 | 현재 stage + ticker 기반 과거 기록 매칭 + /journal/similar 실데이터 |

## Architecture / Implementation Approach

### 데이터 흐름

```
briefing_snapshots (M3)
  └─ action_logs.briefing_snapshot_id (nullable FK)
       └─ /journal: 오늘 안내 자동 조회 + 기록 입력
            └─ /journal/gap-report: action_logs 집계 쿼리
                 └─ /journal/similar: stage·ticker 매칭 쿼리
```

### action_logs 스키마

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | uuid | PK |
| user_id | uuid | FK → auth.users |
| date | date | 기록 날짜 |
| ticker | text | 종목 (nullable — 전체 포지션 기록 허용) |
| briefing_snapshot_id | uuid | FK → briefing_snapshots (nullable) |
| guidance_action | text | 안내 행동 문장 |
| guidance_prohibition | text | 안내 금지 문장 |
| actual_action | text | 실제 행동 (축소/유지/추가매수/전량매도/기타) |
| follow_level | text | 따름/일부 따름/따르지 않음 |
| reason | text | 행동 이유 (nullable) |
| result_day0 | numeric | 당일 손익률 (nullable) |
| result_day1 | numeric | 다음날 손익률 |
| result_day3 | numeric | 3거래일 손익률 |
| result_week1 | numeric | 1주일 손익률 |
| stage | text | 기록 당시 장세 단계 (briefing_snapshots에서 복사 — 쿼리 단순화) |
| created_at | timestamptz | |
| updated_at | timestamptz | |

RLS: 본인 row만 SELECT/INSERT/UPDATE/DELETE.

### 화면 패턴

M3·M4와 동일한 Server Component + Client Component 패턴:
- `page.tsx` (Server Component) → 서버 액션 호출 → Client Component에 데이터 전달
- Client Component ("use client") → 상태 관리 + 서버 액션 호출

### 갭 리포트 계산 방식

SQL 집계 쿼리로 처리 (애플리케이션 레이어가 아닌 DB 집계):
- 준수 비율: `COUNT(*) GROUP BY follow_level`
- 미준수 수익: `follow_level = '따르지 않음' AND result_day1 > 0`
- 미준수 손실: `follow_level = '따르지 않음' AND result_day1 < 0`
- 반복 패턴: `GROUP BY stage, follow_level ORDER BY count DESC LIMIT 1`

### 유사 상황 매칭

1. 오늘 briefing_snapshot에서 stage 조회
2. 현재 positions에서 ticker 목록 조회
3. action_logs에서 stage 일치 + ticker 포함 조건으로 매칭
4. result_day1이 있는 항목 우선 (결과가 있는 과거 기록)

## Dependency Graph

```
009_action_logs.sql (T001)
  └─ app/journal/actions.ts (T002)
      └─ app/journal/page.tsx → JournalClient.tsx (T002)
          └─ app/journal/gap-report/actions.ts (T003)
              └─ app/journal/gap-report/page.tsx → GapReportClient.tsx (T003)
                  └─ app/journal/similar/actions.ts (T004)
                      └─ app/journal/similar/page.tsx → SimilarClient.tsx (T004)
```

## Verification Strategy

- 각 태스크: `npm run build` 타입 체크 통과
- T002: 기록 저장 후 Supabase 대시보드에서 action_logs row 확인
- T003: 1건 이상 기록 후 갭 리포트 화면에서 실데이터 표시 확인
- T004: 유사 상황 화면에서 현재 stage와 일치하는 과거 기록 표시 확인

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| briefing_snapshots가 없어 오늘 안내 조회 불가 | 중 | guidance_action/prohibition 직접 입력 허용 (nullable) |
| 기록 건수 부족으로 갭 리포트 의미 없음 | 중 | SC-005: 5건 미만 시 소표본 경고, 빈 상태가 아닌 제한적 수치 표시 |
| stage 텍스트 불일치로 유사 상황 매칭 실패 | 낮 | stage 비교 시 startsWith로 대분류(상승/변동/하락) 매칭 보완 |

## Open Questions

- 행동 기록에서 오늘 브리핑 안내를 자동으로 가져오지 못할 때(briefing_snapshots 없음) 빈 안내 섹션 표시 vs 직접 입력? → 빈 상태로 표시하고 placeholder로 수동 입력 안내
- result_day1 등 손익률을 입력받을 때 % 단위인지 절댓값인지? → % 단위, -100~+100 범위
