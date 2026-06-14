# Plan: M1 - 승인 게이트 & 인증

## Overview

Supabase Auth 기반으로 이용 신청 접수, 관리자 검토·승인, 게이트 접근 제어를 실제로 작동시킨다.
현재 더미 데이터로만 동작하는 S001(`/apply`), S002(`/apply/status`), S003(`/admin/applications`) 세 화면을 실제 DB·서버 액션·미들웨어에 연결해, 승인된 사용자만 핵심 기능에 진입할 수 있는 상태를 만든다.

## Source Context

- **PRD FR-030~034, FR-036**: 이용 신청 폼 제출 → 상태 조회 → 관리자 검토·승인/거절 → 권한 반영 → 미승인 차단
- **PRD Scenario 5**: 신규 방문자가 신청 제출 → 대기 상태 확인 → 승인 시 핵심 기능 진입
- **PRD Scenario 6**: 관리자 인증 → 신청 목록 조회 → 승인/거절 → 권한·상태 반영 → 통지
- **PRD Assumptions**: 관리자 계정·권한은 운영팀이 별도 부여하며 일반 신청 흐름으로는 관리자 권한을 얻을 수 없음. 서비스는 승인 기반 제한 이용(gated access) 모델로 시작.
- **Roadmap M1 Scope**: Supabase Auth 연동, applications / user_roles DB 스키마, 서버 액션, Next.js 미들웨어 라우트 보호, 관리자 게이트, 관리자 시드.
- **Current State**: S001~S003 UI 목업 완료(더미 데이터). Supabase 패키지 설치됨. Auth·DB·미들웨어 미구현.

## Scope

- Supabase 클라이언트 초기화 (`lib/supabase/server.ts`, `lib/supabase/client.ts`)
- `applications` 테이블 스키마 + RLS 마이그레이션
- `user_roles` 테이블 스키마 + RLS 마이그레이션
- 최초 관리자 시드 방법 확정 + 스크립트 작성
- 이용 신청 서버 액션 (DB insert, 중복 이메일 처리)
- `/apply` 폼 → 서버 액션 연결 + 성공 시 `/apply/status` 리다이렉트
- 신청 상태 조회 API (`getApplicationStatus`) + `/apply/status` 실제 DB 연결
- 관리자 신청 목록 조회 + 상태별 필터 + `/admin/applications` 실제 DB 연결
- 승인 서버 액션: status → approved + Supabase `inviteUserByEmail` 호출 + `user_roles` 등록
- 거절 서버 액션: status → rejected + rejection_reason 저장
- Next.js `middleware.ts`: 핵심 기능 경로 라우트 보호 (미로그인 → `/apply`, 미승인 → `/apply/status`)
- `/admin/*` 관리자 role 게이트

## Out of Scope

- 승인·거절 결과 외부 통지(SMS·이메일 발송) — M4에서 발송 인프라와 함께 구현 (FR-035)
- 소셜 로그인, PASS 수준 본인 인증
- 재신청·만료 정책 (PRD 오픈 이슈)
- 알림 채널 OTP 인증 — M2에서 구현

## Functional Requirements Covered

| FR ID | 요구사항 요약 | 충족 방식 |
|-------|-------------|---------|
| FR-030 | 이용 신청 폼 제출 (이름·연락처·동기·동의) | `submitApplication` 서버 액션 → `applications` DB insert |
| FR-031 | 신청 상태 확인 (대기/승인/거절·사유) | `getApplicationStatus` → `/apply/status` 실제 DB 조회 |
| FR-032 | 미승인 사용자 핵심 기능 접근 차단 | Next.js `middleware.ts` 라우트 보호 → `/apply/status` 리다이렉트 |
| FR-033 | 관리자 신청 목록 상태별 조회·상세 확인 | `getApplications` → `/admin/applications` 실제 DB 연결 |
| FR-034 | 관리자 승인/거절 → 권한·상태 즉시 반영 | `approveApplication` / `rejectApplication` 서버 액션 |
| FR-036 | 관리자 권한 분리 + 관리자 인증 게이트 | `user_roles` 테이블 + middleware admin role 체크 |

## Architecture / Implementation Approach

### 인증 흐름

```
1. 신청 단계 (비인증)
   └─ /apply 폼 제출 → applications 테이블 insert (auth 불필요)
      └─ email을 쿠키에 저장 → /apply/status로 이동

2. 상태 조회 (비인증)
   └─ /apply/status → 쿠키 email로 applications 조회 → 상태 표시

3. 관리자 승인 시
   └─ approveApplication() 서버 액션
      ├─ applications.status = 'approved'
      ├─ Supabase Admin: inviteUserByEmail(email) → 초대 메일 발송
      └─ 사용자가 초대 링크 클릭 → Supabase Auth 세션 생성

4. 승인된 사용자 로그인 후
   └─ middleware: 세션 확인 → applications.status 확인 → approved면 통과
```

### DB 스키마

**`applications` 테이블**
```
id              uuid PK default gen_random_uuid()
email           text NOT NULL
name            text NOT NULL
phone           text
experience      text
motivation      text
status          text NOT NULL default 'pending'  -- pending / approved / rejected
rejection_reason text
created_at      timestamptz default now()
updated_at      timestamptz default now()
```
- email unique 제약 (중복 신청 방지)
- RLS: insert는 누구나 가능(authenticated 포함 anon), select는 email 일치 또는 admin, update는 admin만

**`user_roles` 테이블**
```
user_id   uuid PK references auth.users
role      text NOT NULL  -- 'admin' | 'user'
created_at timestamptz default now()
```
- RLS: read는 본인 또는 admin, insert/update는 admin만

### 서버 액션 파일 구조

```
app/
  apply/
    actions.ts          -- submitApplication, getApplicationStatus
  admin/
    applications/
      actions.ts        -- getApplications, approveApplication, rejectApplication
lib/
  supabase/
    server.ts           -- createServerClient (cookies 기반)
    client.ts           -- createBrowserClient
    admin.ts            -- createAdminClient (service role, server only)
supabase/
  migrations/
    001_applications.sql
    002_user_roles.sql
  seed.sql              -- 최초 관리자 시드
middleware.ts
```

### 미들웨어 라우트 보호 로직

```
보호 대상 경로: /briefing, /positions, /journal, /onboarding,
               /alerts, /market, /principles, /admin

요청 흐름:
1. 비인증 → /apply/*·/apply (신청 경로)는 통과
2. /admin/* → user_roles.role = 'admin' 확인, 아니면 /에 리다이렉트
3. 보호 경로 + 비인증 → /apply 리다이렉트
4. 보호 경로 + 인증 + status ≠ 'approved' → /apply/status 리다이렉트
5. 보호 경로 + 인증 + status = 'approved' → 통과
```

## Dependency Graph

```
lib/supabase/ 초기화 (server + client + admin)
  └─ DB 스키마 마이그레이션 (applications, user_roles)
      ├─ 최초 관리자 시드 (seed.sql)
      │
      ├─ [신청 흐름]
      │   └─ submitApplication 서버 액션 (FR-030)
      │       └─ getApplicationStatus 서버 액션 (FR-031)
      │
      ├─ [관리자 흐름]
      │   └─ getApplications 서버 액션 (FR-033)
      │       └─ approveApplication / rejectApplication 서버 액션 (FR-034)
      │
      └─ [게이트]
          └─ middleware.ts 라우트 보호 (FR-032, FR-036)
```

## Verification Strategy

- **빌드 성공**: `next build` 오류 없음
- **타입 체크**: `tsc --noEmit` 오류 없음
- **수동 시나리오 검증**:
  1. `/apply`에서 신청 제출 → DB 확인 → `/apply/status`에서 "대기 중" 표시
  2. 동일 이메일로 재신청 → 기존 상태 안내 (insert 차단)
  3. `/admin/applications`에서 신청 목록 조회 → 신청 상세 확인
  4. 관리자가 승인 → 신청자 DB status = 'approved' 확인, 초대 메일 발송 확인
  5. 관리자가 거절(사유 입력) → DB status = 'rejected', rejection_reason 저장 확인
  6. `pending` 상태 사용자가 `/briefing` URL 직접 입력 → `/apply/status`로 리다이렉트
  7. 비인증 상태로 `/briefing` 접근 → `/apply`로 리다이렉트
  8. 일반 사용자 세션으로 `/admin/applications` 접근 → 권한 없음 화면

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Supabase `inviteUserByEmail`이 스팸으로 분류되거나 발송 실패 | 승인 후 사용자가 서비스에 진입 못함 | 초대 링크를 관리자 화면에서 직접 복사할 수 있는 fallback 표시 |
| middleware에서 DB 조회 시 레이턴시 증가 | 모든 요청에 추가 지연 | `user_roles`를 Supabase Auth custom claims에 캐싱하거나 쿠키에 role 저장으로 DB 조회 최소화 |
| anon RLS로 인한 applications 무단 조회 | 개인정보 노출 | email 컬럼 기반 RLS (using (email = current_setting('app.user_email', true))) + 관리자만 전체 조회 |
| 관리자 시드 방법 미정으로 M1 착수 지연 | 일정 지연 | T003에서 Supabase Dashboard에서 직접 role 부여하는 방법을 문서화, 별도 스크립트 선택지도 제공 |
| Next.js 16 + Supabase SSR 쿠키 처리 호환성 | 세션 유실·루프 리다이렉트 | @supabase/ssr v0.7 공식 middleware 패턴 그대로 사용, 쿠키 새로고침 로직 포함 |

## Open Questions

1. **Supabase 프로젝트 연결 정보**: `.env.local`에 `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`가 준비되어 있는가? (T001 착수 전 확인 필요)
2. **관리자 시드 정책**: 최초 관리자를 Supabase Dashboard에서 수동 부여할지, seed.sql 스크립트로 관리할지 확정 필요. (T003에서 둘 다 제공하고 사용자가 선택)
3. **중복 신청 재신청 정책**: 거절된 사용자의 재신청 허용 여부·대기 기간은 PRD 오픈 이슈 — M1에서는 거절 상태도 중복으로 처리하고 기존 상태 안내만 한다.
4. **`/apply/status` 상태 조회 방식**: 쿠키 기반(이메일 저장)으로 구현하면 쿠키 삭제 시 상태를 다시 볼 수 없음 — M1에서는 이메일 직접 입력으로 fallback 제공하는 UI를 함께 구현.
