// 미국 반도체 레버리지/인버스 신호 캘리브레이션 — `npx tsx scripts/us-signal-calibrate.ts`
// (사용자 지정 2026-07-13) ProShares USD(2x 반도체)·SSG(-2x)를 한국 하닉 시스템과 같은 방식으로
// 판정하기 위해: ①USD의 선행(기준) 지수 검증 — FKS200 역할을 무엇이 하는가
// ②과거 데이터에서 '추세일'을 추출해 DC1·DC2·급변 단계·모멘텀 임계값을 실측 분포로 도출.
import YahooFinance from "yahoo-finance2";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

type Bar = { t: number; o: number; h: number; l: number; c: number };

async function daily(symbol: string, days: number): Promise<{ date: string; ret: number; close: number }[]> {
  const r = await yf.chart(symbol, { period1: new Date(Date.now() - days * 86400e3), interval: "1d" });
  const q = (r.quotes ?? []).filter((x): x is typeof x & { close: number } => x.close != null);
  const out: { date: string; ret: number; close: number }[] = [];
  for (let i = 1; i < q.length; i++) {
    const d = q[i].date instanceof Date ? q[i].date : new Date(q[i].date);
    out.push({ date: d.toISOString().slice(0, 10), ret: (q[i].close / q[i - 1].close - 1) * 100, close: q[i].close });
  }
  return out;
}

function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  const ma = a.slice(0, n).reduce((s, x) => s + x, 0) / n, mb = b.slice(0, n).reduce((s, x) => s + x, 0) / n;
  let sa = 0, sb = 0, sab = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sa += da * da; sb += db * db; sab += da * db; }
  return sab / Math.sqrt(sa * sb);
}

function quantile(v: number[], q: number): number {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

async function intraday5m(symbol: string, days: number): Promise<Map<string, Bar[]>> {
  const r = await yf.chart(symbol, { period1: new Date(Date.now() - days * 86400e3), interval: "5m" });
  const byDay = new Map<string, Bar[]>();
  for (const q of r.quotes ?? []) {
    if (q.close == null || q.open == null) continue;
    const d = q.date instanceof Date ? q.date : new Date(q.date);
    const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (utcMin < 13 * 60 + 30 || utcMin >= 20 * 60) continue; // 정규장 09:30~16:00 ET (서머타임 UTC-4)
    const day = d.toISOString().slice(0, 10);
    const arr = byDay.get(day) ?? [];
    arr.push({ t: utcMin, o: q.open, h: q.high ?? q.close, l: q.low ?? q.close, c: q.close });
    byDay.set(day, arr);
  }
  return byDay;
}

async function main() {
  // ── ① 선행(기준) 지수 검증 — USD 일간 수익률과의 상관·베타
  console.log("═══ ① ProShares USD의 기준 지수 검증 (2년 일간) ═══");
  const [usd, ssg, sox, soxx, nq, smh] = await Promise.all([
    daily("USD", 730), daily("SSG", 730), daily("^SOX", 730), daily("SOXX", 730), daily("NQ=F", 730), daily("SMH", 730),
  ]);
  const byDate = (arr: { date: string; ret: number }[]) => new Map(arr.map((x) => [x.date, x.ret]));
  const mUsd = byDate(usd);
  const aligned = (other: { date: string; ret: number }[]) => {
    const a: number[] = [], b: number[] = [];
    for (const x of other) { const u = mUsd.get(x.date); if (u !== undefined) { a.push(u); b.push(x.ret); } }
    return { a, b };
  };
  for (const [name, arr] of [["^SOX(필라델피아 반도체)", sox], ["SOXX(ICE 반도체 ETF)", soxx], ["SMH(반에크 반도체)", smh], ["NQ=F(나스닥선물)", nq], ["SSG(-2x)", ssg]] as const) {
    const { a, b } = aligned(arr);
    const c = corr(a, b);
    // 베타: USD ≈ β × 지수
    const beta = a.reduce((s, x, i) => s + x * b[i], 0) / b.reduce((s, x) => s + x * x, 0);
    console.log(`  USD vs ${name}: 상관 ${c.toFixed(4)} · β ${beta.toFixed(2)} (표본 ${a.length}일)`);
  }

  // ── ② 추세일 추출 — ^SOX 5분봉 (최근 55거래일) 로 DC1(10분봉)·DC2·순이동 산출
  console.log("\n═══ ② ^SOX 장중 추세 구조 (최근 ~55거래일 · 5분봉) ═══");
  const soxDays = await intraday5m("^SOX", 58);
  type DayStat = { day: string; move: number; range: number; dc1: number; dc2: number; gapUsable: boolean };
  const stats: DayStat[] = [];
  for (const [day, bars] of soxDays) {
    if (bars.length < 60) continue; // 데이터 온전한 날만 (5분봉 78개 기대)
    bars.sort((x, y) => x.t - y.t);
    const open = bars[0].o, close = bars[bars.length - 1].c;
    const move = ((close - open) / open) * 100;
    const hi = Math.max(...bars.map((b) => b.h)), lo = Math.min(...bars.map((b) => b.l));
    const range = ((hi - lo) / open) * 100;
    // 10분봉 재샘플 → DC1·DC2 (한국 dcLabel과 동일 정의)
    const b10: { o: number; c: number }[] = [];
    for (let i = 0; i + 1 < bars.length; i += 2) b10.push({ o: bars[i].o, c: bars[i + 1].c });
    const sign = Math.sign(close - open);
    const dc1 = sign === 0 ? 0 : b10.filter((b) => Math.sign(b.c - b.o) === sign).length / b10.length;
    const path = b10.reduce((s, b) => s + Math.abs(b.c - b.o), 0);
    const dc2 = path > 0 ? Math.abs(close - open) / path : 0;
    stats.push({ day, move, range, dc1, dc2, gapUsable: true });
  }
  stats.sort((a, b) => a.day.localeCompare(b.day));
  console.log(`  표본 ${stats.length}일`);

  // 추세일 후보: |시가→종가| 상위 30% — 그 날들의 DC1·DC2 분포로 임계값 도출
  const absMoves = stats.map((s) => Math.abs(s.move));
  const trendCut = quantile(absMoves, 0.7);
  const trendDays = stats.filter((s) => Math.abs(s.move) >= trendCut);
  const rangeDays = stats.filter((s) => Math.abs(s.move) < quantile(absMoves, 0.4));
  console.log(`  |시가→종가| 상위 30% 컷: ${trendCut.toFixed(2)}% → 추세일 후보 ${trendDays.length}일 / 횡보 표본 ${rangeDays.length}일`);
  const q = (arr: number[], p: number) => quantile(arr, p).toFixed(2);
  console.log(`  [추세일 후보] DC1 25/50/75%: ${q(trendDays.map(s=>s.dc1),0.25)}/${q(trendDays.map(s=>s.dc1),0.5)}/${q(trendDays.map(s=>s.dc1),0.75)} · DC2: ${q(trendDays.map(s=>s.dc2),0.25)}/${q(trendDays.map(s=>s.dc2),0.5)}/${q(trendDays.map(s=>s.dc2),0.75)}`);
  console.log(`  [횡보 표본]  DC1 25/50/75%: ${q(rangeDays.map(s=>s.dc1),0.25)}/${q(rangeDays.map(s=>s.dc1),0.5)}/${q(rangeDays.map(s=>s.dc1),0.75)} · DC2: ${q(rangeDays.map(s=>s.dc2),0.25)}/${q(rangeDays.map(s=>s.dc2),0.5)}/${q(rangeDays.map(s=>s.dc2),0.75)}`);
  console.log(`  추세일 후보 리스트 (날짜 · 시→종 % · DC1 · DC2):`);
  for (const s of trendDays) console.log(`    ${s.day}  ${s.move >= 0 ? "+" : ""}${s.move.toFixed(2)}%  DC1 ${(s.dc1*100).toFixed(0)}%  DC2 ${s.dc2.toFixed(2)}`);

  // ── ③ 급변·스윙 단계 도출 — ^SOX 당일 등락 분포 (일간 |수익률|)
  console.log("\n═══ ③ 급변 알림 단계 도출 (^SOX 일간 |등락| 2년 분포) ═══");
  const absDaily = sox.map((x) => Math.abs(x.ret));
  console.log(`  |일간등락| 50/75/90/95/99%: ${q(absDaily,0.5)} / ${q(absDaily,0.75)} / ${q(absDaily,0.9)} / ${q(absDaily,0.95)} / ${q(absDaily,0.99)}%`);
  console.log(`  참고: K200선물 급변 스텝 0.56%는 대략 일간등락 중앙값(~0.7%)의 0.8배 수준`);

  // ── ④ RV1 모멘텀 임계값 도출 — ^SOX 5분봉 변화 분포
  console.log("\n═══ ④ 분봉 모멘텀(RV1형) 임계값 도출 (^SOX 5분봉 변화 %p 분포) ═══");
  const m5moves: number[] = [], m5x3: number[] = [], m5x5: number[] = [];
  for (const [, bars] of soxDays) {
    bars.sort((x, y) => x.t - y.t);
    const chg = bars.map((b) => b.c);
    for (let i = 1; i < chg.length; i++) m5moves.push(Math.abs((chg[i] / chg[i - 1] - 1) * 100));
    for (let i = 3; i < chg.length; i++) m5x3.push(Math.abs((chg[i] / chg[i - 3] - 1) * 100));
    for (let i = 5; i < chg.length; i++) m5x5.push(Math.abs((chg[i] / chg[i - 5] - 1) * 100));
  }
  console.log(`  5분봉 1개 |변화| 90/95/99%: ${q(m5moves,0.9)} / ${q(m5moves,0.95)} / ${q(m5moves,0.99)}%p`);
  console.log(`  5분봉 3개 합 90/95/99%: ${q(m5x3,0.9)} / ${q(m5x3,0.95)} / ${q(m5x3,0.99)}%p`);
  console.log(`  5분봉 5개 합 90/95/99%: ${q(m5x5,0.9)} / ${q(m5x5,0.95)} / ${q(m5x5,0.99)}%p`);
  console.log(`  참고: 한국 하닉 기준(5분봉 1.0 / 3개 2.2 / 5개 2.7)은 대략 95~99% 분위였음`);

  // ── ⑤ 갭 분포 (T7·X1용) — 전일 종가 대비 시가
  console.log("\n═══ ⑤ 갭 분포 (^SOX 시가 vs 전일 종가, 55일) ═══");
  const gaps: number[] = [];
  const dayList = [...soxDays.keys()].sort();
  const dailyCloseMap = new Map(sox.map((x) => [x.date, x.close]));
  for (let i = 1; i < dayList.length; i++) {
    const bars = soxDays.get(dayList[i])!;
    bars.sort((x, y) => x.t - y.t);
    const prevClose = dailyCloseMap.get(dayList[i - 1]);
    if (prevClose) gaps.push(Math.abs((bars[0].o / prevClose - 1) * 100));
  }
  console.log(`  |갭| 50/75/90%: ${q(gaps,0.5)} / ${q(gaps,0.75)} / ${q(gaps,0.9)}% (무갭 컷·큰갭 추격금지 X1 기준용)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
