# Tasks: M1 - 승인 게이트 & 인증

> plan.md 기준 구현 태스크 목록. 의존성 순서대로 배열.
> 완료 시 `[ ]` → `[x]` 로 변경.

---

## [x] Task T001 - Supabase 클라이언트 초기화

**Description:** Next.js App Router + SSR에서 Supabase를 안전하게 사용하기 위한 server/client/admin 초기화 파일을 작성하고 환경 변수 가이드를 제공한다.

**Acceptance Criteria:**
- [ ] `lib/supabase/server.ts` — `createServerClient`(@supabase/ssr) 쿠키 핸들러 포함
- [ ] `lib/supabase/client.ts` — `createBrowserClient` 싱글톤
- [ ] `lib/supabase/admin.ts` — `createClient(url, service_role_key)`로 admin 클라이언트 생성 (server only, service role key 사용)
- [ ] `.env.local.example` 파일에 `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` 항목 문서화
- [ ] `next build` 타입 오류 없이 성공

**Verification:**
- [ ] `tsc --noEmit` 오류 없음
- [ ] `.env.local` 실제 값 설정 후 `next dev` 기동 정상

**Dependencies:** 없음

**Likely Files:**
- `lib/supabase/server.ts` (신규)
- `lib/supabase/client.ts` (신규)
- `lib/supabase/admin.ts` (신규)
- `.env.local.example` (신규)

**Estimated Scope:** S

---

## [ ] Task T002 - DB 스키마 마이그레이션 (applications + user_roles)

**Description:** 이용 신청 정보를 저장하는 `applications` 테이블과 관리자/사용자 역할을 구분하는 `user_roles` 테이블을 Supabase에 마이그레이션한다. RLS 정책까지 포함한다.

**Acceptance Criteria:**
- [ ] `supabase/migrations/001_applications.sql` 작성: id(uuid PK), email(text unique NOT NULL), name, phone, experience, motivation, status(text default 'pending'), rejection_reason, created_at, updated_at 컬럼
- [ ] `supabase/migrations/002_user_roles.sql` 작성: user_id(uuid PK references auth.users), role(text: 'admin'|'user'), created_at 컬럼
- [ ] `applications` RLS: anon/authenticated 누구나 insert 가능, select는 email 일치 또는 admin role 보유 사용자만, update는 admin만
- [ ] `user_roles` RLS: 본인 role select 가능, insert/update는 admin 또는 service role만
- [ ] Supabase 대시보드 또는 `supabase db push`로 마이그레이션 적용 확인
- [ ] `applications` 테이블에 updated_at 자동 갱신 트리거 추가

**Verification:**
- [ ] Supabase Table Editor에서 두 테이블 확인
- [ ] Supabase SQL Editor로 RLS 정책 목록 확인
- [ ] `INSERT INTO applications (email, name, ...) VALUES (...)` 테스트 쿼리 성공

**Dependencies:** T001 (Supabase 프로젝트 연결 정보 필요)

**Likely Files:**
- `supabase/migrations/001_applications.sql` (신규)
- `supabase/migrations/002_user_roles.sql` (신규)

**Estimated Scope:** S

---

## [ ] Task T003 - 최초 관리자 시드

**Description:** 서비스 운영 관리자 계정을 부여하는 방법을 확정하고, 재현 가능한 시드 스크립트를 작성한다.

**Acceptance Criteria:**
- [ ] `supabase/seed.sql` 작성: 특정 user_id를 `user_roles`에 admin으로 insert하는 예시 쿼리 (실제 UUID는 주석 처리)
- [ ] `docs/admin-setup.md` 작성: ① Supabase Auth에서 관리자 이메일로 사용자 수동 생성 방법, ② 해당 user_id로 `user_roles`에 admin role insert 방법 (Dashboard SQL Editor 기준) 설명
- [ ] 일반 이용 신청 흐름으로는 admin role을 얻을 수 없음이 RLS로 보장됨

**Verification:**
- [ ] 문서 절차대로 관리자 계정 생성 후 `/admin/applications` 접근 가능 확인 (T008/T009 완료 후)

**Dependencies:** T002

**Likely Files:**
- `supabase/seed.sql` (신규)
- `docs/admin-setup.md` (신규)

**Estimated Scope:** XS

---

## Checkpoint - Supabase 기반 준비 완료

- [ ] T001, T002, T003 완료
- [ ] Supabase 클라이언트 초기화 파일 존재
- [ ] applications + user_roles 테이블 + RLS 마이그레이션 적용됨
- [ ] 관리자 시드 방법 문서화 완료
- [ ] `next build` 성공

---

## [ ] Task T004 - 이용 신청 서버 액션 + /apply 폼 연결

**Description:** `/apply` 화면의 신청 폼을 실제 DB에 저장하는 서버 액션을 구현하고 폼과 연결한다. 중복 이메일 처리와 성공 후 리다이렉트까지 포함한다.

**Acceptance Criteria:**
- [ ] `app/apply/actions.ts` 에 `submitApplication(formData)` 서버 액션 구현
  - email, name, phone, experience, motivation을 `applications` 테이블에 insert
  - 동일 email 중복 신청 시 새 row를 만들지 않고 기존 상태(pending/approved/rejected)를 반환
  - 성공 시 이메일을 쿠키(`applicant_email`, httpOnly, 7일)에 저장
  - 성공 시 `/apply/status`로 리다이렉트
- [ ] `app/apply/page.tsx`의 폼 submit이 `submitApplication` 서버 액션을 호출
- [ ] 폼 validation: email, name은 필수 (빈 값 제출 시 에러 메시지 표시)
- [ ] 중복 신청 시 `/apply/status`로 리다이렉트하며 기존 상태 안내

**Verification:**
- [ ] 폼 제출 후 Supabase `applications` 테이블에 row 생성 확인
- [ ] 동일 이메일로 재제출 시 기존 row 유지, 중복 insert 없음 확인
- [ ] 필수 항목 미입력 시 에러 메시지 표시 확인
- [ ] 성공 후 `/apply/status`로 이동 확인

**Dependencies:** T002 (applications 테이블), T001 (supabase server client)

**Likely Files:**
- `app/apply/actions.ts` (신규)
- `app/apply/page.tsx` (수정 — 서버 액션 연결)

**Estimated Scope:** M

---

## [ ] Task T005 - 신청 상태 조회 + /apply/status 실제 DB 연결

**Description:** `/apply/status` 화면에서 신청자의 현재 상태(대기/승인/거절)를 실제 DB에서 조회해 표시한다. 쿠키 기반 조회와 이메일 직접 입력 fallback을 모두 지원한다.

**Acceptance Criteria:**
- [ ] `app/apply/actions.ts` 에 `getApplicationStatus(email)` 함수 추가 (admin client 사용, service role로 email 기반 조회)
- [ ] `/apply/status` 페이지가 쿠키 `applicant_email`로 자동 조회
- [ ] 쿠키가 없으면 이메일 입력 필드를 표시해 수동 조회 지원
- [ ] 상태별 표시:
  - `pending`: "대기 중 — 검토 후 연락 드리겠습니다" 안내
  - `approved`: "승인됨 — 초대 이메일을 확인해 서비스에 진입하세요" + [시작하기] (로그인 후 `/onboarding`으로)
  - `rejected`: "거절됨" + 거절 사유 표시
- [ ] 조회 결과 없음(미신청) 시 `/apply`로 안내

**Verification:**
- [ ] 신청 완료 후 `/apply/status` 접근 → "대기 중" 상태 표시 확인
- [ ] DB에서 직접 status를 'approved'로 변경 후 페이지 새로고침 → "승인됨" 표시 확인
- [ ] DB에서 직접 status를 'rejected', rejection_reason을 설정 후 → 사유 포함 "거절됨" 표시 확인

**Dependencies:** T004 (applications 테이블 데이터), T001

**Likely Files:**
- `app/apply/actions.ts` (수정 — getApplicationStatus 추가)
- `app/apply/status/page.tsx` (수정 — 실제 DB 조회 연결)

**Estimated Scope:** S

---

## Checkpoint - 신청 흐름 완전 동작

- [ ] T004, T005 완료
- [ ] `/apply` 제출 → DB 저장 → `/apply/status` 상태 표시 E2E 동작
- [ ] 중복 신청 방어 동작
- [ ] 더미 데이터 없이 실제 DB 데이터만 표시

---

## [ ] Task T006 - 관리자 신청 목록 조회 + /admin/applications 실제 DB 연결

**Description:** `/admin/applications` 화면에서 실제 DB의 신청 목록을 상태별로 조회해 표시한다.

**Acceptance Criteria:**
- [ ] `app/admin/applications/actions.ts` 에 `getApplications(status?: string)` 서버 액션 구현 (admin client 사용)
  - 전체 조회 및 status 필터(pending/approved/rejected) 지원
  - created_at 내림차순 정렬
- [ ] `getApplicationDetail(id)` 함수로 단일 신청 상세 조회
- [ ] `/admin/applications` 페이지가 서버 액션으로 실제 목록 데이터 표시
- [ ] 상태별 탭/필터 UI가 실제 필터링 동작
- [ ] 목록 항목 클릭 시 상세 정보(이름·이메일·연락처·신청 동기·경험·신청일·현재 상태) 표시

**Verification:**
- [ ] `applications` 테이블에 test 데이터(pending/approved/rejected 각 1건) 입력 후 목록에 정상 표시 확인
- [ ] 상태 탭 클릭 시 해당 상태만 필터링되어 표시 확인
- [ ] 신청 상세 클릭 시 폼 입력 내용 전체 표시 확인

**Dependencies:** T002, T001, T003 (관리자 계정 필요)

**Likely Files:**
- `app/admin/applications/actions.ts` (신규)
- `app/admin/applications/page.tsx` (수정 — 실제 DB 데이터 연결)

**Estimated Scope:** M

---

## [ ] Task T007 - 승인/거절 서버 액션 + UI 연결

**Description:** 관리자가 신청을 승인하면 상태를 갱신하고 Supabase 초대 메일을 발송한다. 거절 시 사유를 저장한다.

**Acceptance Criteria:**
- [ ] `approveApplication(id)` 서버 액션:
  - `applications.status` = 'approved'로 갱신
  - Supabase Admin Auth `inviteUserByEmail(email)` 호출 → 초대 메일 발송
  - `user_roles`에 `(user_id, 'user')` insert (초대 수락 후 생성되는 user_id는 Supabase Auth webhook 또는 초대 수락 시점에 처리 — M1에서는 approval 시 inviteUserByEmail만 호출하고 user_roles는 사용자가 초대 수락 후 세션 생성 시 자동 insert되도록 트리거 또는 callback 구현)
  - 이미 approved 상태인 경우 중복 처리 방어
- [ ] `rejectApplication(id, reason)` 서버 액션:
  - `applications.status` = 'rejected', `rejection_reason` = reason으로 갱신
- [ ] `/admin/applications` 페이지의 [승인]·[거절(사유 입력)] 버튼이 서버 액션 호출
- [ ] 거절 시 사유 입력 모달/폼 제공
- [ ] 액션 완료 후 목록 갱신 (revalidatePath)
- [ ] `inviteUserByEmail` 실패 시 에러 표시 (DB 상태는 이미 approved로 갱신됨 — 재발송 버튼 제공)

**Verification:**
- [ ] 관리자가 pending 신청 승인 → DB status = 'approved' 확인, 초대 이메일 수신 확인
- [ ] 관리자가 pending 신청 거절(사유 입력) → DB status = 'rejected', rejection_reason 저장 확인
- [ ] `/apply/status`에서 해당 신청자 상태가 갱신되어 표시 확인

**Dependencies:** T006, T001 (admin client)

**Likely Files:**
- `app/admin/applications/actions.ts` (수정 — approve/reject 추가)
- `app/admin/applications/page.tsx` (수정 — 버튼 액션 연결)

**Estimated Scope:** M

---

## Checkpoint - 관리자 검토 흐름 완전 동작

- [ ] T006, T007 완료
- [ ] 관리자가 신청 목록 조회 → 승인/거절 E2E 동작
- [ ] 승인 후 신청자 DB 상태 반영 확인
- [ ] 초대 메일 발송 확인 (Supabase Auth Emails)

---

## [ ] Task T008 - Next.js 미들웨어 라우트 보호 (FR-032)

**Description:** 미승인 사용자가 핵심 기능 경로에 접근하면 차단하는 Next.js `middleware.ts`를 구현한다.

**Acceptance Criteria:**
- [ ] `middleware.ts` (프로젝트 루트) 구현
- [ ] Supabase @supabase/ssr 패턴으로 쿠키 세션 갱신 포함
- [ ] 보호 경로 목록: `/briefing`, `/positions`, `/journal`, `/onboarding`, `/alerts`, `/market`, `/principles`
- [ ] 공개 경로(통과): `/apply`, `/apply/status`, `/` (랜딩)
- [ ] 비인증 상태로 보호 경로 접근 → `/apply` 리다이렉트
- [ ] 인증 상태 + `applications.status` ≠ 'approved' → `/apply/status` 리다이렉트
- [ ] 인증 상태 + `applications.status` = 'approved' → 요청 통과
- [ ] middleware에서 DB 조회 최소화: auth session의 user email로 applications 단건 조회만 수행

**Verification:**
- [ ] 비인증 상태로 `/briefing` URL 직접 입력 → `/apply`로 리다이렉트 확인
- [ ] pending 상태 사용자로 로그인 후 `/briefing` 접근 → `/apply/status`로 리다이렉트 확인
- [ ] approved 상태 사용자로 로그인 후 `/briefing` 접근 → 정상 진입 확인
- [ ] `/apply` 경로는 인증 여부 무관 접근 가능 확인

**Dependencies:** T002 (applications 테이블), T001 (supabase server client)

**Likely Files:**
- `middleware.ts` (신규)

**Estimated Scope:** M

---

## [ ] Task T009 - 관리자 인증 게이트 (FR-036)

**Description:** `/admin/*` 경로를 관리자 role 보유 사용자만 접근하도록 미들웨어에 추가한다.

**Acceptance Criteria:**
- [ ] `middleware.ts`에 `/admin/*` 경로 처리 추가
- [ ] 비인증 상태로 `/admin/*` 접근 → `/apply` 리다이렉트
- [ ] 인증 상태 + `user_roles.role` ≠ 'admin' → `/` 리다이렉트 (권한 없음)
- [ ] 인증 상태 + `user_roles.role` = 'admin' → 요청 통과
- [ ] `/admin/applications` 페이지에 "[관리자]" 배지/표시 노출 (PRD 8절 공통 요소 확정 사항)

**Verification:**
- [ ] 일반 사용자(approved)로 로그인 후 `/admin/applications` 직접 접근 → `/`로 리다이렉트 확인
- [ ] 비인증 상태로 `/admin/applications` 접근 → `/apply`로 리다이렉트 확인
- [ ] 관리자 계정으로 로그인 후 `/admin/applications` 정상 접근 확인

**Dependencies:** T008 (middleware.ts 기반), T002 (user_roles 테이블), T003 (관리자 계정)

**Likely Files:**
- `middleware.ts` (수정 — admin 게이트 추가)
- `app/admin/applications/page.tsx` (수정 — [관리자] 배지 추가)

**Estimated Scope:** S

---

## Checkpoint - M1 최종 검증

- [ ] T008, T009 완료
- [ ] 전체 게이트 E2E 시나리오 통과:
  - [ ] 신규 방문자 신청 → 대기 상태 확인 → 관리자 승인 → 초대 수락 → `/onboarding` 진입
  - [ ] pending 사용자의 보호 경로 접근 차단 확인
  - [ ] 일반 사용자의 `/admin/*` 접근 차단 확인
- [ ] `next build` 성공
- [ ] 더미 데이터(`app/_data/mock.ts`)가 M1 관련 화면(S001~S003)에서 실제 DB 데이터로 대체됨
- [ ] 사용자 검토 가능 상태
