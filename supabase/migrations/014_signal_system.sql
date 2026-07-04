-- M7 레버리지·인버스 신호 시스템 (docs/signal-system-master-spec.md · signal-system-ext-modules.md)
-- 시장 데이터는 사용자 공용 — 읽기는 로그인 사용자 전체, 쓰기는 service role(RLS 우회) 전용.

-- 장중 틱 시계열 (60초 폴링 축적 — T-신호·DC1/DC2·O1·B1 계산의 원천)
create table public.signal_ticks (
  id           bigint generated always as identity primary key,
  date         date not null,                -- KST 거래일
  ts           timestamptz not null,         -- 수집 시각
  fut_px       double precision,             -- K200 선물 현재가
  fut_chg      double precision,             -- 전일대비 %
  k200_px      double precision,             -- KOSPI200 지수 (베이시스용)
  hynix_px     double precision,
  hynix_chg    double precision,
  samsung_px   double precision,
  samsung_chg  double precision,
  hynix_frgn   double precision,             -- 하닉 외인 잠정 순매매량(주)
  samsung_frgn double precision,
  hynix_inst   double precision,             -- 기관 잠정 순매매량 (L9 흡수 판정)
  samsung_inst double precision,
  nikkei_chg   double precision,             -- D1
  twii_chg     double precision,             -- D3
  nq_chg       double precision,             -- D2 (기록 전용)
  breadth      double precision,             -- W1 상승/(상승+하락)
  basis        double precision,             -- B1 선물-현물
  created_at   timestamptz not null default now()
);
create index signal_ticks_date_ts on public.signal_ticks (date, ts);

-- 판정 스냅샷 로그 (시점별 엔진 출력 — 예측 vs 실제 대조용)
create table public.signal_judgments (
  id           bigint generated always as identity primary key,
  date         date not null,
  ts           timestamptz not null,
  phase        text not null,                -- 장전/관찰/판정/관리/마감
  day_type     text,                         -- 추세일상방/추세일하방/횡보일/반전후보/이벤트보수/대기
  bias         jsonb,                        -- 축1 판정 전체
  trend        jsonb,                        -- T1~T8·DC1/DC2·스코어
  setups       jsonb,                        -- L/S 체크리스트·차단 상태
  risk         jsonb,                        -- 스탑·비중 수치
  ext          jsonb,                        -- 확장 모듈 값
  created_at   timestamptz not null default now()
);
create index signal_judgments_date on public.signal_judgments (date, ts);

-- 일일 피처·라벨 (마스터 8장 학습 파이프라인 + 확장기획서 8.2 스키마)
create table public.signal_daily_features (
  date               date primary key,
  -- 라벨 (장후 확정)
  dc1                double precision,       -- 동방향 10분봉 비율
  dc2                double precision,       -- 효율비
  day_return         double precision,
  gap                double precision,
  intraday_range     double precision,
  day_label          text,                   -- 상방추세일/하방추세일/비추세일
  -- 장전 피처
  premarket          jsonb,                  -- C1~C5·매크로·모멘텀 스냅샷
  bias_0830          jsonb,
  -- 장초반 피처 (09:30·10:00)
  early              jsonb,                  -- 갭·첫30분·외인 페이스·T-스코어
  judgment_0930      text,
  judgment_1030      text,
  -- 확장 모듈 (확장기획서 8.2 — 판정 미사용이어도 매일 기록)
  nr7_flag           boolean,
  nr4_ib_flag        boolean,
  open_type          text,                   -- drive/test_drive/auction/undetermined
  open_cross_count   integer,
  open_max_adverse   double precision,
  basis_z_10am       double precision,
  basis_slope_10am   double precision,
  breadth_10am       double precision,
  breadth_divergence double precision,
  distortion_tag     boolean,
  vkospi_peak        double precision,       -- 소스 확보 전까지 null
  vkospi_peakout_time time,
  atr14_pct          double precision,
  stop_pct_used      double precision,
  stop_mode          text,                   -- fixed/atr
  close_extend_applied boolean,
  close_1500_px      double precision,
  close_1515_px      double precision,
  -- 정성 수동 입력 (annotate API)
  cause_tag          text,                   -- 전쟁/관세/실적/수급/소송/AI뉴스 등
  cause_note         text,                   -- 원인 주석 1줄
  consensus_intact   boolean,                -- L8 이익 컨센서스 유지 여부
  cause_non_earnings boolean,                -- L7 낙폭 원인이 비실적 요인
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create trigger signal_daily_features_updated_at
  before update on public.signal_daily_features
  for each row execute function public.handle_updated_at();

alter table public.signal_ticks enable row level security;
alter table public.signal_judgments enable row level security;
alter table public.signal_daily_features enable row level security;

-- 읽기: 로그인 사용자 공용. 쓰기 정책 없음 = service role만 기록.
create policy "authenticated can read signal_ticks"
  on public.signal_ticks for select to authenticated using (true);
create policy "authenticated can read signal_judgments"
  on public.signal_judgments for select to authenticated using (true);
create policy "authenticated can read signal_daily_features"
  on public.signal_daily_features for select to authenticated using (true);
