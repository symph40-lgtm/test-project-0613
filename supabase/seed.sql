-- 최초 관리자 시드
-- 사용법: Supabase Dashboard > SQL Editor에서 아래 쿼리를 실행한다.
-- 실행 전에 <ADMIN_USER_ID>를 실제 user UUID로 교체할 것.
-- (UUID는 Dashboard > Authentication > Users에서 확인)

-- insert into public.user_roles (user_id, role)
-- values ('<ADMIN_USER_ID>', 'admin')
-- on conflict (user_id) do update set role = 'admin';

-- 참고: 일반 신청 흐름(inviteUserByEmail)으로 생성된 사용자는
--       트리거에 의해 role='user'로 자동 등록되며, 이 시드로만 admin이 될 수 있다.
