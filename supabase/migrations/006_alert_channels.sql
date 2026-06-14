-- 알림 채널 테이블 (이메일·SMS 인증 및 수신 동의)
create table public.alert_channels (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users on delete cascade,
  channel_type   text not null check (channel_type in ('email', 'sms')),
  contact        text not null,
  verified       boolean not null default false,
  consent_given  boolean not null default false,
  otp_code       text,
  otp_expires_at timestamptz,
  updated_at     timestamptz not null default now(),
  unique (user_id, channel_type)
);

create trigger alert_channels_updated_at
  before update on public.alert_channels
  for each row execute function public.handle_updated_at();

alter table public.alert_channels enable row level security;

create policy "users can select own alert_channels"
  on public.alert_channels for select
  using (auth.uid() = user_id);

create policy "users can insert own alert_channels"
  on public.alert_channels for insert
  with check (auth.uid() = user_id);

create policy "users can update own alert_channels"
  on public.alert_channels for update
  using (auth.uid() = user_id);

create policy "users can delete own alert_channels"
  on public.alert_channels for delete
  using (auth.uid() = user_id);
