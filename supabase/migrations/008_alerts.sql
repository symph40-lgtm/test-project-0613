-- 알림 이력 테이블 (장중 알림·시황 발송·승인 통지 모두 포함)
create table public.alerts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  trigger_key   text not null check (trigger_key in (
                  'low', 'drop5', 'futures', 'rebound',
                  'intraday_summary', 'approval'
                )),
  ticker        text,
  severity      text not null default 'medium' check (severity in ('high', 'medium', 'low')),
  message       jsonb,
  market_snapshot jsonb,
  is_sent       boolean not null default false,
  sent_at       timestamptz,
  read_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger alerts_updated_at
  before update on public.alerts
  for each row execute function public.handle_updated_at();

alter table public.alerts enable row level security;

-- 본인 알림 조회 (SELECT)
create policy "users can select own alerts"
  on public.alerts for select
  using (auth.uid() = user_id);

-- 본인 알림 업데이트 (읽음 처리 등, UPDATE)
create policy "users can update own alerts"
  on public.alerts for update
  using (auth.uid() = user_id);

-- INSERT는 서비스 롤 전용 (RLS로 일반 사용자 INSERT 막음)
-- API 라우트에서 서비스 롤 키 사용
