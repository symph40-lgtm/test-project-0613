# Plan: M3 — 아침 브리핑 (데이터 + AI 판단)

## Overview

시장 데이터를 실제로 수집하고, AI(Claude)가 9단계 장세를 판정해 종합 판단·근거 점수를 생성한다.
사용자가 더미 데이터 대신 오늘 실제 시장 상황과 자신의 포지션을 반영한 행동 결론을 `/briefing`에서 확인할 수 있다.

---

## Source Context

- **PRD FR-002** — AI 종합 판단 결론 우선 제시
- **PRD FR-003** — 9단계 장세 판정 + 리스크 점수
- **PRD FR-004** — 행동/금지 라벨 (방어 우선/비중 축소/유지/신규 매수 금지 등)
- **PRD FR-005** — 근거 점수(금리·환율·유가·반도체·수급·채권)·핵심 이슈 표시
- **PRD FR-006** — 버핏식 장기 관점 보조 제시 (단정 아닌 대조 관점)
- **PRD FR-020** — 2차원 맵: 큰 장세 압력 × 오늘 상황
- **PRD FR-021** — 외국인·기관·개인 수급 반영
- **PRD FR-022** — 이슈 지속성 (하루 소음 vs. 며칠 리스크)
- **PRD FR-029** — 리스크 코칭 언어 (단정 금지, 원칙 기반)
- **Roadmap M3 블로커** — 시장 데이터 소스, LLM 모델·캐싱 전략 결정 필요

---

## Scope

- 패키지 설치: `yahoo-finance2`, `@anthropic-ai/sdk`
- 환경 변수 추가: `ANTHROPIC_API_KEY`, `FRED_API_KEY`
- `briefing_snapshots` DB 테이블 (날짜별 판단 캐시 + M5 행동 기록 연결)
- 시장 데이터 수집: Yahoo Finance (US 지수·한국 지수·환율·유가) + FRED API (미국 금리)
- 리스크 점수 계산 로직 (6개 지표 → 0~100 + 9단계 장세 판정)
- Claude API 연동 + 아침 브리핑 AI 생성 (FR-029 시스템 프롬프트)
- 브리핑 캐시 전략: `briefing_snapshots`에 저장, 1시간 이내 재사용
- `/briefing` 페이지 → 실데이터 연결 (종합 판단·행동·금지·버핏)
- `/briefing/evidence` 페이지 → 근거 점수 + 수급 실데이터
- `/briefing/preclose` 페이지 → 마감 전 판단 (간소화, 야간 이벤트 정적 캘린더)

---

## Out of Scope

- 장중 실시간 데이터 갱신 (M4)
- 야간 이벤트 자동 스캔 (M4에서 구현; M3는 정적 캘린더)
- 배치 선생성 스케줄러 (M4 인프라)
- 증권사 계좌 수급 원데이터 (Yahoo Finance 대체 사용)
- 사용자별 섹터 근거 점수 완전 개인화 (M3는 글로벌 + 사용자 섹터 결합)

---

## Functional Requirements Covered

| FR | 충족 방식 |
|----|----------|
| FR-002 | Claude API 생성 verdict, Claude 결론 우선 배치 |
| FR-003 | `classifyStage(riskScore)` 함수 → 9단계 + riskScore 0~100 |
| FR-004 | Claude 출력에 `dos[]`, `donts[]` 항목 포함 |
| FR-005 | 6개 지표별 `evidenceScores` 계산 + coreIssues 목록 Claude 생성 |
| FR-006 | Claude 출력에 `buffett` 필드, 시스템 프롬프트에 "대조 관점" 지시 |
| FR-020 | Claude 출력에 2차원 맵 좌표(pressureLevel, situationLevel) 포함 |
| FR-021 | Yahoo Finance 수급 데이터(외국인 방향 프록시) 반영 |
| FR-022 | Claude 출력에 issuesDuration 필드(하루/며칠) |
| FR-029 | 시스템 프롬프트에 리스크 코칭 언어 5원칙 명시 |

---

## Architecture / Implementation Approach

### 패키지 추가

```bash
npm install yahoo-finance2 @anthropic-ai/sdk
```

### 환경 변수

```
ANTHROPIC_API_KEY=sk-ant-...       # Anthropic 대시보드에서 발급
FRED_API_KEY=                      # fred.stlouisfed.org 무료 등록
```

### 시장 데이터 수집 전략

**Yahoo Finance (`yahoo-finance2`):**
| 심볼 | 의미 |
|------|------|
| `^GSPC` | S&P 500 |
| `^NDX` | NASDAQ-100 |
| `^SOX` | PHLX 반도체 지수 |
| `^KS11` | 코스피 |
| `^KQ11` | 코스닥 |
| `DX-Y.NYB` | 달러 인덱스 |
| `USDKRW=X` | 달러/원 환율 |
| `CL=F` | WTI 유가 |
| `^TNX` | 미국 10Y 금리 (Yahoo Finance 제공) |
| `005930.KS` | 삼성전자 (사용자 포지션에 해당하는 주요 한국 종목) |

**FRED API (federal reserve 경제 데이터):**
| Series ID | 의미 |
|-----------|------|
| `DGS10` | 미국 10년물 국채 금리 |
| `DEXKOUS` | 달러/원 환율 (공식) |

실제 FRED API는 daily 업데이트 시차가 있어 Yahoo Finance가 더 실시간에 가깝다. Yahoo Finance를 주 소스로 사용하고 FRED를 백업으로 활용.

### 리스크 점수 계산 (`lib/market/risk.ts`)

각 지표를 0~100 점수로 정규화:
```
금리 위험   = 10Y 금리 당일 변화 기반 (상승 = 위험 증가)
환율 위험   = 달러/원 당일 변화 기반 (원화 약세 = 위험 증가)
유가 위험   = WTI 당일 변화 기반 (급락 또는 급등 = 위험)
반도체 섹터 = SOX 지수 당일 변화 기반 (하락 = 위험)
수급 위험   = 외국인 방향 프록시 (S&P 대비 코스피 언더퍼폼)
채권 이동   = 10Y 금리 하락 시 방어 신호 (역방향)
```

복합 점수:
```
composite = 0.25×금리 + 0.15×환율 + 0.10×유가 + 0.30×반도체 + 0.10×수급 + 0.10×채권
```

### 9단계 장세 판정

| composite | 장세 |
|-----------|------|
| 0–20 | 상승 3단계 |
| 21–35 | 상승 2단계 |
| 36–50 | 상승 1단계 |
| 51–60 | 변동 1단계 |
| 61–70 | 변동 2단계 |
| 71–80 | 변동 3단계 |
| 81–88 | 하락 1단계 |
| 89–94 | 하락 2단계 |
| 95–100 | 하락 3단계 |

### AI 브리핑 생성 (`lib/ai/briefing.ts`)

**모델**: `claude-haiku-4-5` (속도·비용 최적화, 브리핑 생성용)
**캐싱**: 동일 날짜 + 동일 사용자 포지션 → `briefing_snapshots` 재사용

**시스템 프롬프트 핵심 (FR-029):**
```
당신은 스탁가드의 리스크 코칭 시스템입니다.
절대 규칙:
1. "~해라", "~사세요", "~파세요" 등 투자 명령을 사용하지 않습니다.
2. "~할 것입니다" 단정 대신 "~가능성이 높습니다", "~검토해 볼 시점입니다" 사용.
3. 버핏식 관점은 단기 대응과 분리된 대조 관점으로만 제시합니다.
4. 사용자의 보유 종목·레버리지 비중·원칙을 반영한 개인화된 코칭을 제공합니다.
5. 항상 면책: 이 내용은 투자 조언이 아닌 리스크 인식 코칭입니다.
```

**출력 JSON 스키마:**
```json
{
  "verdict": "오늘 브리핑 결론 (1~2문장)",
  "stage": "변동장 3단계",
  "dos": ["행동 1", "행동 2", "행동 3"],
  "donts": ["금지 1", "금지 2"],
  "buffett": "버핏식 보조 관점 (1문장)",
  "coreIssues": ["핵심 이슈 1", "핵심 이슈 2", "핵심 이슈 3"],
  "supplyNotes": ["수급 요약 1", "수급 요약 2"],
  "pressureLevel": 0.7,
  "situationLevel": 0.3,
  "issuesDuration": [{"issue": "이슈명", "duration": "하루" | "며칠" | "이상"}]
}
```

**폴백 처리:**
- Yahoo Finance 실패 시: 이전 날 `briefing_snapshots` 데이터 사용 + "전날 기준 데이터" 배너 표시
- Claude API 실패 시: 리스크 점수 기반 정적 템플릿 텍스트 생성

### DB 스키마 (`briefing_snapshots`)

```sql
CREATE TABLE briefing_snapshots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid REFERENCES auth.users ON DELETE CASCADE,
  date         date NOT NULL,
  market_data  jsonb,    -- 원시 시장 데이터
  risk_scores  jsonb,    -- 6개 지표 점수
  risk_score   integer,  -- 종합 점수 0~100
  stage        text,     -- '변동장 3단계' 등
  ai_output    jsonb,    -- Claude 전체 출력
  is_fallback  boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, date)
);
```

### 컴포넌트 구조

- `app/briefing/page.tsx` → async Server Component, `getBriefing(userId, date)` 호출
- `app/briefing/BriefingClient.tsx` (선택적) → 현재 정적 콘텐츠이므로 Server Component만으로 충분
- `app/briefing/evidence/page.tsx` → 근거 점수 실데이터
- `app/briefing/preclose/page.tsx` → 마감 전 판단

### 캐시 전략

```
getBriefing(userId, date):
  1. SELECT FROM briefing_snapshots WHERE user_id=$1 AND date=$2
  2. IF 존재 AND updated_at > NOW()-1hour → RETURN cached
  3. ELSE → fetchMarketData() + calculateRisk() + callClaude() → UPSERT → RETURN fresh
```

---

## Dependency Graph

```
npm install yahoo-finance2 @anthropic-ai/sdk
  └─ 환경 변수 ANTHROPIC_API_KEY + FRED_API_KEY 설정

supabase/migrations/007_briefing_snapshots.sql
  └─ lib/market/types.ts (MarketData, RiskScores, BriefingSnapshot 타입)
      └─ lib/market/fetch.ts (fetchMarketData: Yahoo + FRED)
          └─ lib/market/risk.ts (calculateRiskScores, classifyStage)
              └─ lib/ai/briefing.ts (generateBriefing: Claude API 호출)
                  └─ app/briefing/actions.ts (getBriefing: 캐시 + 생성 통합)
                      └─ app/briefing/page.tsx (실데이터 연결)
                          └─ [Checkpoint 1]
                      └─ app/briefing/evidence/page.tsx
                          └─ [Checkpoint 2]
                      └─ app/briefing/preclose/page.tsx
                          └─ [Checkpoint 3 / Final]
```

---

## Verification Strategy

- `npm run build` 에러 없음
- `/briefing` 접속 → Claude가 생성한 실제 verdict, stage 표시
- `/briefing/evidence` 접속 → 실제 계산된 근거 점수 6개 표시
- 동일 날짜 재접속 → `briefing_snapshots` row 재사용 (DB 확인)
- Claude API 키 없을 시 폴백 텍스트 표시

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Yahoo Finance 비공식 API 불안정 | 시장 데이터 수집 실패 | 전날 snapshots fallback + "어제 기준" 배너 |
| Claude API 응답 지연 (>5s) | SC-001(3분 이내) 위반 | `briefing_snapshots` 캐시로 90% 요청 처리 |
| 한국 시장 데이터 품질 (`^KS11`) | KOSPI 변화 부정확 | Yahoo Finance는 장마감 이후 데이터. 장중에는 15분 지연 데이터 사용 |
| Claude 출력 JSON 파싱 실패 | 브리핑 렌더링 실패 | try/catch + 정적 템플릿 폴백 |
| FRED API 키 미설정 | 금리 데이터 없음 | Yahoo Finance `^TNX` 심볼로 대체 (미설정 시 자동 fallback) |

---

## Open Questions

1. **ANTHROPIC_API_KEY 발급 여부**: Anthropic Console에서 API 키를 아직 발급하지 않았다면 M3 시작 전에 필요. 없을 경우 정적 템플릿 폴백으로 M3 빌드 가능하지만 AI 생성 텍스트가 아님.
2. **FRED_API_KEY**: fred.stlouisfed.org 무료 등록 → API 키 발급. 없어도 Yahoo Finance `^TNX`로 대체 가능.
3. **배치 선생성 스케줄**: M3에서는 요청 시 생성 + 캐시. M4에서 매일 새벽 배치 생성으로 전환.
4. **야간 지표 캘린더**: `/briefing/preclose`에서 오늘 밤 예정 이벤트 데이터. M3에서는 정적 데이터 또는 Claude가 일반 경제지식으로 예측. M4에서 자동 스캔으로 교체.
