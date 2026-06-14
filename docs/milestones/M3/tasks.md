# Tasks: M3 — 아침 브리핑 (데이터 + AI 판단)

---

## [ ] Task T001 — 패키지 설치 + 환경 변수 + DB 마이그레이션

**Description:** M3에 필요한 npm 패키지를 설치하고, 환경 변수를 `.env.local`에 추가하고, `briefing_snapshots` 테이블을 생성한다.

**Acceptance Criteria:**
- [ ] `npm install yahoo-finance2 @anthropic-ai/sdk` 성공
- [ ] `.env.local`에 `ANTHROPIC_API_KEY` 추가 (사용자 직접 입력)
- [ ] `.env.local`에 `FRED_API_KEY` 추가 (없으면 Yahoo Finance `^TNX` fallback — 선택)
- [ ] `.env.example`에 두 변수 문서화
- [ ] `supabase/migrations/007_briefing_snapshots.sql` 작성·실행 성공
  - 컬럼: `id`, `user_id`, `date` (date), `market_data` (jsonb), `risk_scores` (jsonb), `risk_score` (integer), `stage` (text), `ai_output` (jsonb), `is_fallback` (boolean), `created_at`, `updated_at`
  - UNIQUE(user_id, date), RLS 적용, updated_at 트리거

**Verification:**
- [ ] `npm run build` 성공 (새 패키지 포함)
- [ ] Supabase Table Editor에서 `briefing_snapshots` 테이블 확인

**Dependencies:** 없음

**Likely Files:**
- `supabase/migrations/007_briefing_snapshots.sql` (신규)
- `.env.example` (수정)
- `package.json` (패키지 추가)

**Estimated Scope:** XS

---

## [ ] Task T002 — 시장 데이터 수집 파이프라인

**Description:** Yahoo Finance와 FRED API로 시장 데이터를 수집하는 라이브러리를 구현한다.

**Acceptance Criteria:**
- [ ] `lib/market/types.ts` — `MarketData`, `RiskScores`, `EvidenceScore`, `BriefingSnapshot` 타입 정의
- [ ] `lib/market/fetch.ts` — `fetchMarketData(): Promise<MarketData>` 구현
  - Yahoo Finance: `^GSPC`, `^NDX`, `^SOX`, `^KS11`, `USDKRW=X`, `CL=F`, `^TNX` 동시 조회
  - 실패 지표는 `null`로 처리 (부분 실패 허용)
  - FRED_API_KEY 있으면 `DGS10` 추가 조회
- [ ] `MarketData` 타입: 각 지표의 현재가·전일비·변화율 포함

**Verification:**
- [ ] `lib/market/fetch.ts`를 직접 호출하는 임시 테스트 스크립트 또는 `/api/market-test` Route Handler로 JSON 응답 확인
- [ ] `npm run build` 성공

**Dependencies:** T001

**Likely Files:**
- `lib/market/types.ts` (신규)
- `lib/market/fetch.ts` (신규)

**Estimated Scope:** M

---

## [ ] Task T003 — 리스크 점수 계산 + 9단계 장세 판정

**Description:** 수집된 시장 데이터로 6개 리스크 점수를 계산하고 9단계 장세를 판정하는 pure function을 구현한다.

**Acceptance Criteria:**
- [ ] `lib/market/risk.ts` 구현:
  - `calculateRiskScores(market: MarketData): RiskScores` — 6개 지표(금리·환율·유가·반도체·수급·채권) 각 0~100 점수 계산
  - `calculateCompositeScore(scores: RiskScores): number` — 가중 평균 복합 점수
  - `classifyStage(composite: number): string` — 9단계 문자열 반환
- [ ] 점수 계산 규칙 (plan.md 참조):
  - 금리: 10Y 금리 당일 변화율 기반 (상승폭 클수록 위험 높음)
  - 반도체: SOX 지수 당일 변화율 기반 (하락폭 클수록 위험)
  - 가중치: 금리 0.25, 환율 0.15, 유가 0.10, 반도체 0.30, 수급 0.10, 채권 0.10
- [ ] null 지표는 해당 지표 제외 후 가중치 재분배

**Verification:**
- [ ] 예시 입력으로 `classifyStage(78)` → "변동장 3단계" 확인
- [ ] `npm run build` 성공

**Dependencies:** T001, T002

**Likely Files:**
- `lib/market/risk.ts` (신규)

**Estimated Scope:** S

---

## [ ] Task T004 — Claude API 연동 + 브리핑 AI 생성

**Description:** Anthropic Claude API를 연동해 시장 데이터 + 사용자 포지션 기반 개인화 브리핑을 생성한다. FR-029 리스크 코칭 언어 시스템 프롬프트를 적용한다.

**Acceptance Criteria:**
- [ ] `lib/ai/client.ts` — Anthropic SDK 클라이언트 초기화 (ANTHROPIC_API_KEY 미설정 시 에러 throw)
- [ ] `lib/ai/briefing.ts` — `generateBriefing(market, riskScores, positions, principles): Promise<AiBriefingOutput>` 구현
  - 모델: `claude-haiku-4-5` (속도/비용 최적화)
  - FR-029 시스템 프롬프트: 리스크 코칭 언어 5원칙 적용
  - 출력 JSON: `verdict`, `stage`, `dos[]`, `donts[]`, `buffett`, `coreIssues[]`, `supplyNotes[]`, `pressureLevel`, `situationLevel`, `issuesDuration[]`
  - JSON 파싱 실패 시 폴백 정적 텍스트 반환
- [ ] ANTHROPIC_API_KEY 미설정 시: 리스크 점수 기반 정적 폴백 텍스트 반환 (`is_fallback: true`)

**Verification:**
- [ ] `ANTHROPIC_API_KEY` 설정 환경에서 `generateBriefing` 호출 → valid JSON 응답 확인
- [ ] 미설정 환경에서 폴백 텍스트 반환 확인
- [ ] `npm run build` 성공

**Dependencies:** T001, T002, T003

**Likely Files:**
- `lib/ai/client.ts` (신규)
- `lib/ai/briefing.ts` (신규)
- `lib/ai/types.ts` (신규)

**Estimated Scope:** M

---

## [ ] Task T005 — /briefing 페이지 실데이터 연결 + 캐시

**Description:** `briefing_snapshots` 테이블을 활용한 캐시 전략을 구현하고, `/briefing` 메인 페이지를 실데이터로 연결한다.

**Acceptance Criteria:**
- [ ] `app/briefing/actions.ts` — `getBriefing(date?: string): Promise<BriefingSnapshot>` 구현
  - DB에서 오늘 날짜 캐시 조회 (`updated_at > NOW()-1hour` 조건)
  - 캐시 히트 시 바로 반환
  - 캐시 미스 시: `fetchMarketData()` → `calculateRiskScores()` → `generateBriefing()` → `briefing_snapshots` UPSERT → 반환
  - 전체 실패 시: 전날 스냅샷 + `is_fallback: true` 반환
- [ ] `app/briefing/page.tsx` 업데이트:
  - 목업 `briefing` 데이터 제거
  - `getBriefing()` 호출 → 실데이터 표시
  - Server Component 유지 (데이터 서버에서 fetch)
  - 폴백 시 "어제 기준 데이터입니다" 배너 표시
  - `riskScore`, `stage`, `verdict`, `dos[]`, `donts[]`, `buffett` 실제 값으로 표시

**Verification:**
- [ ] `/briefing` 접속 → Claude 생성 verdict·stage 표시
- [ ] 재접속 → `briefing_snapshots` row 재사용 (DB 확인)
- [ ] 폴백 동작 확인 (ANTHROPIC_API_KEY 임시 제거 시)
- [ ] `npm run build` 성공

**Dependencies:** T001~T004

**Likely Files:**
- `app/briefing/actions.ts` (신규)
- `app/briefing/page.tsx` (수정)

**Estimated Scope:** M

---

## Checkpoint 1 — 아침 브리핑 핵심 흐름 동작

- [ ] T001~T005 완료
- [ ] `/briefing` 에서 실제 AI 생성 판단(verdict, stage, dos, donts, buffett) 표시
- [ ] `briefing_snapshots` 테이블에 캐시 row 확인
- [ ] `npm run build` 성공
- [ ] 사용자 검토 가능 상태

---

## [ ] Task T006 — /briefing/evidence 근거 점수 실데이터 연결

**Description:** `/briefing/evidence` 페이지에 실제 계산된 6개 근거 점수와 핵심 이슈, 수급 데이터를 연결한다.

**Acceptance Criteria:**
- [ ] `app/briefing/evidence/page.tsx` 업데이트:
  - 목업 `evidenceScores`, `supply`, `coreIssues` 데이터 제거
  - `getBriefing()` 재사용 (이미 캐시된 결과 사용)
  - `riskScores` → 6개 지표 점수 + 라벨 표시
  - `coreIssues[]` → 핵심 이슈 목록
  - `supplyNotes[]` → 수급 요약
- [ ] 각 지표 점수에 `note` 필드: 점수 범위 기반 자동 라벨
  - 0~30: "안정", 31~60: "주의", 61~80: "높음", 81~100: "취약"

**Verification:**
- [ ] `/briefing/evidence` 접속 → 6개 지표 실제 점수·라벨 표시
- [ ] `npm run build` 성공

**Dependencies:** T005

**Likely Files:**
- `app/briefing/evidence/page.tsx` (수정)

**Estimated Scope:** S

---

## [ ] Task T007 — /briefing/preclose 마감 전 판단 연결

**Description:** `/briefing/preclose` 페이지에 마감 전 판단을 실데이터로 연결한다. M3에서는 야간 이벤트를 Claude가 일반 지식 기반으로 제공하고, 종목별 판단은 오늘 장중 데이터 + 포지션을 반영한다.

**Acceptance Criteria:**
- [ ] `lib/ai/briefing.ts`에 `generatePreclose(market, riskScores, positions): Promise<AiPrecloseOutput>` 추가
  - 오늘 시장 흐름 요약
  - 야간 주요 이벤트 예측 (Claude 일반 지식 기반, 정적 캘린더 미구현)
  - 종목별 판단 (유지/축소/매도/현금화) — positions 리스트 기반
  - 결과별 시나리오 (상회/부합/하회)
- [ ] `app/briefing/preclose/page.tsx` 업데이트:
  - 목업 `preCloseScenarios`, `perStockCalls` 데이터 제거
  - `getBriefing()`의 캐시 + 추가 preclose 생성 호출
  - 실제 데이터 표시

**Verification:**
- [ ] `/briefing/preclose` 접속 → Claude 생성 마감 전 종목별 판단 표시
- [ ] `npm run build` 성공

**Dependencies:** T005

**Likely Files:**
- `lib/ai/briefing.ts` (수정)
- `app/briefing/preclose/page.tsx` (수정)

**Estimated Scope:** S

---

## Checkpoint 2 — M3 최종

- [ ] T006, T007 완료
- [ ] 전체 브리핑 흐름 검증:
  - `/briefing` → 실제 AI 종합 판단
  - `/briefing/evidence` → 6개 근거 점수
  - `/briefing/preclose` → 마감 전 종목별 판단
- [ ] `npm run build` 에러 없음
- [ ] Supabase `briefing_snapshots` 테이블에 오늘 날짜 데이터 확인
- [ ] 사용자 검토 가능 상태, M4 진행 전 승인 대기
