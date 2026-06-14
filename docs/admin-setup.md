# 관리자 계정 설정 가이드

## 개요

스탁가드 관리자는 일반 신청 흐름으로 권한을 얻을 수 없으며,  
운영팀이 아래 절차로 직접 부여한다. (PRD Assumption FR-036)

---

## Step 1. Supabase Auth에서 관리자 계정 생성

1. [Supabase Dashboard](https://supabase.com/dashboard) 접속
2. 프로젝트 선택 → **Authentication** → **Users** 탭
3. **Add user** → **Create new user** 클릭
4. 관리자 이메일·비밀번호 입력 후 생성
5. 생성된 사용자의 **UUID** 복사 (예: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)

---

## Step 2. user_roles 테이블에 admin role 부여

1. Dashboard → **SQL Editor** → **New query**
2. 아래 쿼리에서 `<ADMIN_USER_ID>`를 Step 1에서 복사한 UUID로 교체 후 실행

```sql
insert into public.user_roles (user_id, role)
values ('<ADMIN_USER_ID>', 'admin')
on conflict (user_id) do update set role = 'admin';
```

---

## Step 3. 검증

- 해당 이메일로 `/admin/applications` 접근 → 관리자 화면 진입 확인
- (T008/T009 구현 완료 후 검증 가능)

---

## 주의사항

- `seed.sql`의 쿼리는 주석 처리된 예시이며, 실제 UUID로 교체 후 실행해야 한다.
- `SUPABASE_SERVICE_ROLE_KEY`는 서버 전용이며 절대 클라이언트(브라우저)에 노출하지 않는다.
- 일반 이용 신청 흐름(`inviteUserByEmail`)으로 생성된 사용자는 RLS에 의해 admin role을 얻을 수 없다.
