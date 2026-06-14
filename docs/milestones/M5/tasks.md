# Tasks: M5 — 행동 기록 & 갭 리포트

---

## [x] Task T001 — DB 마이그레이션: action_logs 테이블

**Description:** 날짜·종목별 행동 기록을 저장하는 `action_logs` 테이블을 생성한다. 안내 내용·실제 행동·따름 여부·이유·4개 시점 결과를 한 row에 저장하며, `briefing_snapshots`와 optional FK로 연결한다.

**Acceptance Criteria:**
- [ ] `supabase/migrations/009_action_logs.sql` 작성:
  - 컬럼: `id` (uuid PK), `user_id` (FK → auth.users), `date` (date, NOT NULL), `ticker` (text, nullable), `briefing_snapshot_id` (uuid nullable FK → briefing_snapshots), `guidance_action` (text), `guidance_prohibition` (text), `actual_action` (text NOT NULL, CHECK IN ('축소','유지','추가매수','전량매도','기타')), `follow_level` (text NOT NULL, CHECK IN ('따름','일부 따름','따르지 않음')), `reason` (text), `result_day0` (numeric nullable), `result_day1` (numeric nullable), `result_day3` (numeric nullable), `result_week1` (numeric nullable), `stage` (text), `created_at`, `updated_at`
  - RLS: 본인 row SELECT/INSERT/UPDATE/DELETE
  - `updated_at` 트리거
- [ ] SQL 파일 문법 검토 완료

**Verification:**
- [ ] `npm run build` 성공
- [ ] Supabase SQL Editor에서 사용자 직접 실행 (지침 확인)

**Dependencies:** 없음

**Likely Files:**
- `supabase/migrations/009_action_logs.sql` (신규)

**Estimated Scope:** XS

---

## [ ] Task T002 — 행동 기록 입력 서버 액션 + 화면 실데이터 연결

**Description:** 행동 기록 입력 화면(`/journal`)을 실데이터로 전환한다. 오늘 브리핑 안내를 자동 조회하고, 실제 행동·따름 여부·이유·결과를 입력받아 `action_logs`에 저장한다.

**Acceptance Criteria:**
- [ ] `app/journal/actions.ts` 신규 ("use server"):
  - `getTodayGuidance()`: `briefing_snapshots`에서 오늘 날짜 row의 `ai_output.action`·`ai_output.prohibition` 조회. 없으면 null 반환
  - `saveActionLog(data: { date, ticker?, guidance_action, guidance_prohibition, actual_action, follow_level, reason?, result_day0?, result_day1?, result_day3?, result_week1?, stage? })`: `action_logs` INSERT, INSERT 후 `/journal/gap-report`로 redirect
  - `getActionLogs()`: 본인 기록 최신순 20건 조회
- [ ] `app/journal/page.tsx` Server Component로 전환:
  - `getTodayGuidance()` 호출 → `JournalClient`에 guidance 전달
- [ ] `app/journal/JournalClient.tsx` 신규 ("use client"):
  - guidance가 있으면 안내 카드에 실제 action/prohibition 표시, 없으면 "오늘 브리핑을 먼저 확인해주세요" 안내
  - 실제 행동 선택 (축소/유지/추가매수/전량매도/기타)
  - 따른 정도 선택 (따름/일부 따름/따르지 않음)
  - 이유 입력 textarea
  - 결과 4개 시점 입력 (%, nullable)
  - `saveActionLog` 호출 on submit
  - 저장 중 pending 상태 표시
- [ ] 기존 `app/journal/page.tsx` 하드코딩 목업 제거

**Verification:**
- [ ] 기록 저장 후 Supabase `action_logs` 테이블에 row 생성 확인
- [ ] 브리핑 스냅샷 없는 환경에서 빈 안내 카드 + 수동 입력 가능 확인
- [ ] `npm run build` 성공

**Dependencies:** T001

**Likely Files:**
- `app/journal/actions.ts` (신규)
- `app/journal/page.tsx` (수정)
- `app/journal/JournalClient.tsx` (신규)

**Estimated Scope:** M

---

## Checkpoint 1 — 행동 기록 저장 동작

- [ ] T001~T002 완료
- [ ] 기록 입력 후 DB에 row 생성 확인
- [ ] 브리핑 안내 자동 조회 동작 확인
- [ ] `npm run build` 성공

---

## [ ] Task T003 — 판단 갭 리포트 실데이터 연결

**Description:** `/journal/gap-report` 화면을 `action_logs` 집계 데이터로 전환한다. 준수 비율·미준수 후 수익/손실 사례·반복 패턴을 DB 집계로 계산하고, 소표본 경고(5건 미만)를 포함한다.

**Acceptance Criteria:**
- [ ] `app/journal/gap-report/actions.ts` 신규 ("use server"):
  - `getGapReport()`: 다음을 반환
    - `total`: 전체 기록 수
    - `followed`: follow_level = '따름' 건수
    - `partial`: '일부 따름' 건수
    - `ignored`: '따르지 않음' 건수
    - `winDespiteIgnore`: follow_level = '따르지 않음' AND result_day1 > 0 건수
    - `lossDespiteIgnore`: follow_level = '따르지 않음' AND result_day1 < 0 건수
    - `pattern`: stage·follow_level 조합 중 가장 많이 반복된 패턴 문장 (예: "변동장에서 안내를 따르지 않은 경우가 가장 많습니다")
    - `isSmallSample`: total < 5
- [ ] `app/journal/gap-report/page.tsx` Server Component로 전환
- [ ] `app/journal/gap-report/GapReportClient.tsx` 신규 ("use client"):
  - 실데이터 기반 준수 비율 바 차트
  - 미준수 수익/손실 카드
  - 반복 패턴 카드
  - 소표본이면 StateNote 경고 표시 (데모 토글 버튼 제거)
  - 기록이 0건이면 빈 상태("아직 기록이 없습니다. 행동 기록을 추가해보세요.")
- [ ] 기존 하드코딩 목업 제거

**Verification:**
- [ ] 1건 이상 기록 저장 후 실데이터가 갭 리포트에 표시되는지 확인
- [ ] 기록 0건 시 빈 상태 표시 확인
- [ ] `npm run build` 성공

**Dependencies:** T001, T002

**Likely Files:**
- `app/journal/gap-report/actions.ts` (신규)
- `app/journal/gap-report/page.tsx` (수정)
- `app/journal/gap-report/GapReportClient.tsx` (신규)

**Estimated Scope:** M

---

## [ ] Task T004 — 유사 상황 회상 실데이터 연결

**Description:** `/journal/similar` 화면을 현재 장세·종목 조건과 과거 `action_logs`를 매칭해 실데이터로 전환한다. 가장 조건이 많이 겹치는 과거 사례 1건을 표시하고, 없으면 빈 상태를 표시한다.

**Acceptance Criteria:**
- [ ] `app/journal/similar/actions.ts` 신규 ("use server"):
  - `getSimilarCase()`:
    1. `briefing_snapshots`에서 최신 row의 `stage` 조회
    2. `positions`에서 현재 ticker 목록 조회
    3. `action_logs`에서 다음 조건 매칭:
       - stage 앞 3글자(상승/변동/하락) 일치 (`LEFT(stage, 2)`)
       - ticker가 현재 positions에 포함되거나 ticker IS NULL
       - result_day1 IS NOT NULL (결과 있는 기록 우선)
       - 오늘 날짜 제외
    4. 가장 최근 매칭 1건 반환
    5. 현재 stage와 매칭 ticker를 `overlaps` 배열로 포함
    6. 없으면 null 반환
- [ ] `app/journal/similar/page.tsx` Server Component로 전환
- [ ] `app/journal/similar/SimilarClient.tsx` 신규 ("use client"):
  - similarCase가 있으면: 겹치는 조건 목록, 날짜·안내·행동·결과 카드, 참고할 점
  - 없으면 빈 상태 ("아직 과거 기록이 없거나 유사한 상황을 찾지 못했습니다")
- [ ] 기존 하드코딩 목업 제거

**Verification:**
- [ ] 다른 날짜 기록이 있을 때 유사 상황 화면에서 실데이터 표시 확인
- [ ] 기록 없을 때 빈 상태 확인
- [ ] `npm run build` 성공

**Dependencies:** T001, T002, T003

**Likely Files:**
- `app/journal/similar/actions.ts` (신규)
- `app/journal/similar/page.tsx` (수정)
- `app/journal/similar/SimilarClient.tsx` (신규)

**Estimated Scope:** M

---

## Checkpoint 2 — M5 최종

- [ ] T001~T004 완료
- [ ] 행동 기록 입력 → DB 저장 → 갭 리포트 실데이터 표시 end-to-end 확인 (SC-005)
- [ ] 소표본(5건 미만) 경고 표시 확인
- [ ] 유사 상황 매칭 동작 확인
- [ ] `npm run build` 에러 없음
- [ ] Supabase `action_logs` 테이블에 데이터 확인
- [ ] 사용자 검토 가능 상태, M6 진행 전 승인 대기

**사용자가 Supabase SQL Editor에서 실행해야 할 파일:**
- `supabase/migrations/009_action_logs.sql` (T001 완료 후)
