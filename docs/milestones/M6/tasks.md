# Tasks: M6 — 개인화 인사이트 & 오판 분석

---

## [x] Task T001 — DB 마이그레이션: personalization_settings + briefing_bookmarks

**Description:** 개인화 설정(ON/OFF·기록 제외 목록)과 "내일 아침 다시 보기" 예약을 저장하는 두 테이블을 생성한다.

**Acceptance Criteria:**
- [ ] `supabase/migrations/010_personalization.sql` 작성:
  - `personalization_settings` 테이블:
    - `user_id` uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE
    - `personalization_enabled` boolean NOT NULL DEFAULT true
    - `excluded_log_ids` uuid[] NOT NULL DEFAULT '{}'
    - `updated_at` timestamptz
    - `updated_at` 트리거
    - RLS: 본인 row SELECT/INSERT/UPDATE
  - `briefing_bookmarks` 테이블:
    - `id` uuid PRIMARY KEY DEFAULT gen_random_uuid()
    - `user_id` uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE
    - `scheduled_date` date NOT NULL
    - `created_at` timestamptz DEFAULT now()
    - RLS: 본인 row SELECT/INSERT/DELETE
    - UNIQUE(user_id, scheduled_date) — 같은 날짜 중복 예약 방지

**Verification:**
- [ ] `npm run build` 성공
- [ ] Supabase SQL Editor에서 사용자 직접 실행

**Dependencies:** 없음

**Likely Files:**
- `supabase/migrations/010_personalization.sql` (신규)

**Estimated Scope:** XS

---

## [x] Task T002 — 개인화 인사이트 LLM 생성 + `/journal/insights` 실데이터 연결

**Description:** action_logs 기반으로 AI가 개인화 인사이트를 생성하고, personalization_settings ON/OFF 및 기록 제어(전체 삭제·초기화)를 실데이터로 연결한다.

**Acceptance Criteria:**
- [ ] `app/journal/insights/actions.ts` 신규 ("use server"):
  - `getPersonalizationSettings()`: `personalization_settings` 조회, 없으면 `{ enabled: true, excludedLogIds: [] }` 반환
  - `savePersonalizationSettings(enabled: boolean)`: upsert
  - `generateInsights()`: 다음 로직:
    1. `personalization_settings` 조회 → `enabled=false`이면 null 반환
    2. action_logs 최근 30건 조회 (excluded_log_ids 제외)
    3. 3건 미만이면 fallback 반환: `{ strong: "기록이 더 쌓이면 인사이트를 생성합니다.", weak: "", reinforce: [] }`
    4. claude-haiku-4-5 호출: follow_level·stage·actual_action 패턴 분석 → `{ strong, weak, reinforce: string[] }` 반환
    5. ANTHROPIC_API_KEY 없으면 rule-based fallback (가장 많은 follow_level, stage 조합으로 문장 생성)
  - `deleteAllLogs()`: action_logs 전체 삭제 + excluded_log_ids 초기화 → revalidatePath("/journal")
- [ ] `app/journal/insights/page.tsx` Server Component로 전환:
  - `getPersonalizationSettings()` + `generateInsights()` 병렬 호출
- [ ] `app/journal/insights/InsightsClient.tsx` 신규 ("use client"):
  - 인사이트 카드 (잘 맞았던 판단·취약했던 판단·강화 조건)
  - 개인화 반영 ON/OFF 토글 → `savePersonalizationSettings()` 호출
  - "전체 삭제·초기화" 버튼 → 확인 다이얼로그 → `deleteAllLogs()` 호출
  - 기존 하드코딩 목업 제거

**Verification:**
- [ ] action_logs 3건 이상일 때 인사이트 표시 확인
- [ ] 3건 미만이면 fallback 메시지 표시 확인
- [ ] ON/OFF 토글 후 새로고침 시 상태 유지 확인
- [ ] `npm run build` 성공

**Dependencies:** T001

**Likely Files:**
- `app/journal/insights/actions.ts` (신규)
- `app/journal/insights/page.tsx` (수정)
- `app/journal/insights/InsightsClient.tsx` (신규)

**Estimated Scope:** M

---

## Checkpoint 1 — 개인화 설정 + 인사이트 동작

- [ ] T001~T002 완료
- [ ] 인사이트 LLM 또는 fallback 표시 확인
- [ ] ON/OFF + 삭제 제어 동작 확인
- [ ] `npm run build` 성공

---

## [x] Task T003 — 오판 분석 LLM 생성 + `/journal/misjudgment` 실데이터 연결

**Description:** "따르지 않음 + 손실" 기록 중 가장 최근 건을 선택해 LLM으로 오판 원인·바뀐 변수·다음 반영안을 생성하고 실데이터로 표시한다. "이번 사례 제외"는 excluded_log_ids에 추가한다.

**Acceptance Criteria:**
- [ ] `app/journal/misjudgment/actions.ts` 신규 ("use server"):
  - `getMisjudgmentCase()`:
    1. `personalization_settings` 조회 → excluded_log_ids 확인
    2. action_logs에서 `follow_level='따르지 않음' AND result_day1 < 0` + excluded 제외 → 최신 1건
    3. 없으면 null 반환
    4. briefing_snapshot_id가 있으면 해당 snapshot의 ai_output도 함께 반환
  - `generateMisjudgmentReport(log, snapshot)`: claude-haiku-4-5 호출:
    - 입력: 당시 안내(guidance_action/prohibition), 실제 행동, 결과(result_day1), 브리핑 판단(ai_output.dos/donts·coreIssues)
    - 출력 JSON: `{ verdict, result, basisThen: string[], changed: string[], cause, nextApply }`
    - ANTHROPIC_API_KEY 없으면 rule-based fallback
  - `excludeLog(logId: string)`: `personalization_settings.excluded_log_ids`에 logId 추가 (ARRAY_APPEND 또는 fetch + update)
- [ ] `app/journal/misjudgment/page.tsx` Server Component로 전환:
  - `getMisjudgmentCase()` 호출 → 데이터 없으면 빈 상태 props 전달
  - 데이터 있으면 `generateMisjudgmentReport()` 호출
- [ ] `app/journal/misjudgment/MisjudgmentClient.tsx` 신규 ("use client"):
  - 데이터 없으면 빈 상태: "아직 분석할 오판 사례가 없습니다. 안내를 따르지 않은 결과를 기록하면 분석해드립니다."
  - 있으면: 당시 판단·실제 결과 카드, 판단 당시 근거 vs 이후 바뀐 변수 대조 카드, 오판 원인·다음 반영안 카드
  - "이번 사례 제외" 버튼 → `excludeLog()` 호출 → 성공 메시지
  - "학습에 반영" 버튼 → `/journal/insights`로 이동
  - 기존 하드코딩 목업 제거

**Verification:**
- [ ] action_logs에 follow_level='따르지 않음' + result_day1 < 0 기록 있을 때 오판 분석 표시 확인
- [ ] 없을 때 빈 상태 표시 확인
- [ ] "이번 사례 제외" 후 다시 접속 시 다른 사례 또는 빈 상태 확인
- [ ] `npm run build` 성공

**Dependencies:** T001, T002

**Likely Files:**
- `app/journal/misjudgment/actions.ts` (신규)
- `app/journal/misjudgment/page.tsx` (수정)
- `app/journal/misjudgment/MisjudgmentClient.tsx` (신규)

**Estimated Scope:** M

---

## [ ] Task T004 — FR-038 "내일 아침 다시 보기" 예약 실DB 연결 + 브리핑 알림 배너

**Description:** 마감 전 판단 화면의 "내일 아침 다시 보기 예약" 버튼을 실제 DB에 저장하고, 다음날 브리핑 접속 시 예약 알림 배너를 표시한다.

**Acceptance Criteria:**
- [ ] `app/briefing/preclose/actions.ts` 신규 ("use server"):
  - `bookmarkNextBriefing()`: `briefing_bookmarks` INSERT (scheduled_date = 내일 날짜), UNIQUE 충돌 시 무시(upsert)
  - `hasTodayBookmark()`: scheduled_date = 오늘 날짜인 bookmark 존재 여부 반환
- [ ] `app/briefing/preclose/PrecloseClient.tsx` 수정:
  - "내일 아침 다시 보기 예약" 버튼 → `bookmarkNextBriefing()` 호출
  - `booked` 상태를 로컬 useState로 유지 (UX 유지), 서버 액션 성공 시 true
- [ ] `app/briefing/page.tsx` 수정:
  - `hasTodayBookmark()` 호출 → `hasBookmark: boolean`을 `BriefingClient`에 전달
- [ ] `app/briefing/BriefingClient.tsx` 수정:
  - `hasBookmark=true`이면 화면 상단에 알림 배너 표시:
    "어제 마감 전 판단에서 오늘 브리핑을 예약했습니다. 오늘 안내를 확인해보세요."
  - 배너 닫기(X 버튼) 시 로컬 상태로 숨김

**Verification:**
- [ ] 마감 전 판단 예약 버튼 클릭 → briefing_bookmarks row 생성 확인
- [ ] 다음날 브리핑 접속 시 알림 배너 표시 확인
- [ ] 배너 닫기 동작 확인
- [ ] `npm run build` 성공

**Dependencies:** T001

**Likely Files:**
- `app/briefing/preclose/actions.ts` (신규)
- `app/briefing/preclose/PrecloseClient.tsx` (수정)
- `app/briefing/page.tsx` (수정)
- `app/briefing/BriefingClient.tsx` (수정)

**Estimated Scope:** S

---

## Checkpoint 2 — M6 최종

- [ ] T001~T004 완료
- [ ] 개인화 인사이트 LLM/fallback 표시 (FR-027)
- [ ] 오판 분석 LLM/fallback 표시 (FR-026)
- [ ] ON/OFF·기록 제외·전체 삭제 동작 확인 (FR-028)
- [ ] 마감 전 예약 → 다음날 브리핑 알림 배너 (FR-038)
- [ ] `npm run build` 에러 없음
- [ ] Supabase 테이블 데이터 확인

**사용자가 Supabase SQL Editor에서 실행해야 할 파일:**
- `supabase/migrations/010_personalization.sql` (T001 완료 후)
