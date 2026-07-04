# M7 — 레버리지·인버스 신호 시스템 (독립 모듈)

기준 문서: [signal-system-master-spec.md](../../signal-system-master-spec.md) (마스터 v2.4) · [signal-system-ext-modules.md](../../signal-system-ext-modules.md) (확장 모듈 v1.0)

## 범위 (사용자 확정)

- 마스터 Phase 1(장전 브리핑 + 추세일 판별) + daily_features 기록 파이프라인 + 확장 모듈(A1 ATR 스탑 활성, N1·W1 구현+기본 OFF, B1·O1·V1·C1 기록 전용) + 6월 재현 검증
- 알림 없음 — 화면(대시보드)만
- 전용 페이지 `/signal` 신설 + 홈 전체 메뉴에 링크. 기존 기능과 독립된 모듈로 구성 (`lib/signal/`)

## 아키텍처

```
lib/signal/
  config.ts    — 전 파라미터·확장모듈 on/off 플래그 (확장기획서 8.3 초기값)
  types.ts     — PremarketContext·IntradayTick·TrendResult·Judgment·DailyFeatures
  data.ts      — 수집 어댑터 (아래 데이터 소스 표)
  store.ts     — Supabase 저장/로드 (ticks·judgments·daily_features)
  engine/
    bias.ts    — 축1 Bias (C1~C5 + L6~L11 요소 → 방향·강도 1~3)
    trend.ts   — T1~T8 스코어, DC1/DC2, O1 시가유형, 5분·10분 리샘플
    setups.ts  — L/S 필수·가점·금지(X·XS) 판정
    risk.ts    — R1~R8 수치 + A1 ATR 스탑
    decide.ts  — 2.5.4 의사결정 트리 통합 (순수 함수 — 백테스트 재사용)
  backtest.ts  — 6월 시나리오(4.4·2.5.7) 합성 시계열 재현 → 엔진 판정 대조

app/signal/page.tsx + SignalClient.tsx  — 대시보드 (60초 폴링)
app/api/signal/state/route.ts           — 수집→판정→저장→반환 (장중 tick 축적 겸용)
app/api/signal/annotate/route.ts        — 원인 주석·컨센서스 수동 입력 (학습 피처)
app/api/cron/signal-eod/route.ts        — 15:40 장후 배치 (DC1/DC2 라벨 확정, features 확정)

supabase/migrations/014_signal_system.sql — signal_ticks · signal_judgments · signal_daily_features
```

**장중 시계열 축적 방식**: 별도 상주 프로세스 없이, `/signal` 페이지가 열려 있는 동안 60초 폴링이 서버 라우트를 호출 → 라우트가 현재 시세를 `signal_ticks`에 적재(30초 최소 간격 가드) → 축적된 series로 T-신호·DC를 계산. 무인 운용이 필요하면 외부 크론이 같은 엔드포인트를 호출(CRON_SECRET).

## 데이터 소스 (확인 완료)

| 항목 | 소스 | 비고 |
|---|---|---|
| K200 선물 실시간 | 기존 `fetchKospi200Futures` (네이버 폴링, KIS 야간) | Confirmation 핵심 입력 |
| KOSPI200 지수 실시간 | 네이버 폴링 `domestic/index/KPI200` | B1 베이시스 |
| 하닉/삼전 실시간 | 기존 `fetchKoreanQuote` | |
| 일봉 OHLCV (하닉·삼전·KPI200) | 네이버 fchart XML | NR7·ATR14·누적낙폭·갭 |
| 외인 수급 잠정 (하닉·삼전) | 기존 `fetchStockFlow` (모바일 trend) | L5 — 종목 단위로 대체(아래 편차) |
| 등락종목수 | `finance.naver.com/sise/sise_index` HTML 파싱 | W1 breadth |
| 매크로 (환율·미금리·나스닥·SOX) | 기존 `fetchMarketData` (야후·FRED) | C3~C5 |
| 니케이 선물·대만 자취안·나스닥 선물 | 야후 NKD=F · ^TWII · NQ=F | D1·D3 (D2 기록만) |
| 이벤트 캘린더 | `config.ts` 수동 배열 (NFP·CPI·FOMC 월별) | C1. 월 1회 갱신 |
| VKOSPI | 무료 소스 부재 → **null 기록** | V1은 스키마만, KIS 확장 시 활성 |
| 외인 선물 수급·프로그램 매매 | KIS 미연동 → **null 기록** | T4·T5 미산출 처리 |

## 스펙 대비 의도적 편차 (데이터 제약)

1. **T4(외인 선물)·T5(프로그램)·T8(거래대금)·T2(VWAP)** — 실시간 무료 소스 부재. T-스코어는 *산출 가능한 신호의 만점 대비 비율*로 정규화해 판정(예: 가용 만점 7점이면 추세일 기준 8/13≈0.615 비율 적용). 미산출 신호는 UI에 "데이터 없음"으로 명시. T2는 거래량 없이 **TWAP(시간가중평균) 편측성으로 근사**하고 근사임을 표기.
2. **L5(외인 수급)** — KOSPI 전체 잠정치 대신 **하닉/삼전 개별 외인 잠정 순매매**로 판정(①20일 평균 대비 배율 ②30분 구간 감속 ③상대강도 — 마스터 5장의 "배율 정규화 원칙"과 정합).
3. **L7(낙폭 원인)·L8(컨센서스)·원인 주석** — 자동화 불가한 정성 판단은 대시보드에서 수동 입력(annotate API) → daily_features에 기록.
4. VKOSPI(V1)는 값 수집 불가 → 컬럼만 예약.

## 검증 (마스터 6장 Phase 1 성공 기준)

- `backtest.ts`: 6월 실사례 6건(6/9·6/12·6/23·7/3·6/17·6/22)을 합성 틱 시계열로 재구성해 실제 엔진(decide)에 투입, 스펙 4.4 표의 기대 판정과 대조. `/signal` 검증 섹션에 pass/fail 표시
- 특이도 우선: 횡보일 시나리오(방향 전환 3회 이상)를 추가해 "진입 안 함" 판정 확인
- `npm run build` 통과

## 리스크 규칙 고정 (엔진에 하드코딩, 학습·확장이 무효화 불가)

- X1~X3·XS1~XS2 하드 블록이 모든 판정에 우선
- R1 -3%(A1 ATR 옵션: k=0.7, clamp 3~8%) · R2 트레일링 -4% · R5 비중 Bias 강도 연동 · R6 일일 -1% 한도(표시) · 확장 가점 합산은 T-스코어 총점의 30% 캡 (확장기획서 8.5)
