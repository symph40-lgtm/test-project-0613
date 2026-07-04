# M7 태스크

- [x] T1. DB 마이그레이션 `014_signal_system.sql` — signal_ticks · signal_judgments · signal_daily_features (+RLS)
- [x] T2. `lib/signal/config.ts` — 파라미터·확장 플래그·이벤트 캘린더
- [x] T3. `lib/signal/types.ts` — 공용 타입
- [x] T4. `lib/signal/data.ts` — 일봉 fchart·KPI200 폴링·등락종목수·크로스마켓·기존 어댑터 묶음
- [x] T5. `lib/signal/engine/` — bias · trend(T1~T8, DC1/DC2, O1) · setups(L/S/X/XS) · risk(R+A1) · decide
- [x] T6. `lib/signal/store.ts` — tick 적재·시리즈 로드·judgment 스냅샷·daily_features upsert
- [x] T7. API 라우트 — /api/signal/state · /api/signal/annotate · /api/cron/signal-eod
- [x] T8. `lib/signal/backtest.ts` — 6월 재현 시나리오 + 횡보일 특이도 케이스 (`npx tsx scripts/signal-backtest.ts`)
- [x] T9. UI — /signal 대시보드 (판정 헤더·브리핑·T-스코어·정합성·셋업·리스크·확장모듈·검증·기록)
- [x] T10. 홈 전체 메뉴에 링크 추가
- [x] T11. `npm run build` 통과 + 검증 시나리오 7/7 pass
- [x] T12. 커밋

## 남은 운영 작업 (코드 외)

- [ ] Supabase Dashboard SQL Editor에서 `supabase/migrations/014_signal_system.sql` 적용 (미적용이어도 화면은 동작 — 기록만 안 됨)
- [ ] (선택) 외부 크론: 장중 60초 `/api/signal/state`(로그인 세션 필요 — 페이지 열어두기로 대체 가능), 15:40 `/api/cron/signal-eod?secret=<CRON_SECRET>`
- [ ] `lib/signal/config.ts`의 EVENT_CALENDAR 월 1회 갱신
- [ ] 확장 모듈 활성화는 60거래일 기록 축적 후 리프트 검증 통과분만 (확장기획서 8.5)
