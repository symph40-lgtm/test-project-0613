// 프리장→정규장 개장 반전 분석 (사용자 질문 2026-08-08 — 8/6 밤 실사례: F 20:31 SOXL 진입 →
// 22:31 개장 급락(창1 반대·E1 전환) → 22:49 SOXS도 컷 → 직후 급등 -3.64%):
//   npx tsx scripts/soxx-open-reversal-sweep.ts
// 질문 3개를 실측한다 (F 프리장 선행 진입일 한정):
//   ① 개장 직후 F 방향 역행이 얼마나 자주·얼마나 크게 오나
//   ② 변형: 프리장 끝(09:29)에 청산(MOC격) → 09:40 '개장 10분 추세' 방향 재진입 — 현행 대비?
//   ③ 양쪽 컷(더블컷)된 날, 2차 컷 이후 종가까지 드리프트 — 재진입 룰 후보가 성립하나
// 현행 주기준과 같은 부품(judgeSoxxDay rebox)·같은 데이터(SOXXM)·스탑 -2%.
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { judgeSoxxDay, SOXX_ET_OPEN, SOXX_ET_PRE, SOXX_ET_CLOSE, type SoxxBar } from "../lib/signal/us/soxxV2";
import { PREDICT_CONFIG as C } from "../lib/predict/config";
import type { PredictDailyBar } from "../lib/predict/types";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const CACHE = resolve(process.cwd(), ".predict-cache");
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
const pctOf = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const STOP = 2.0;

// 레그: 진입 후 스탑(-2%) 감시, forceI 전 종료 시 그 가격
function leg(bars: SoxxBar[], i0: number, dir: 1 | -1, px: number, closePx: number, forceI?: number, forcePx?: number): { pnl: number; cut: boolean; cutI: number | null } {
  const s = STOP / 100, lim = forceI ?? bars.length;
  for (let k = i0 + 1; k < lim; k++) {
    if (dir === 1 ? bars[k].low <= px * (1 - s) : bars[k].high >= px * (1 + s)) return { pnl: -STOP, cut: true, cutI: k };
  }
  return { pnl: ((forceI !== undefined ? (forcePx ?? closePx) : closePx) - px) / px * 100 * dir, cut: false, cutI: null };
}

async function main() {
  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 3 * 365 * 86400e3), interval: "1d" });
  const daily: PredictDailyBar[] = (rD.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  const files = readdirSync(CACHE).filter((f) => /^SOXXM-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();

  type R = {
    date: string; fdir: 1 | -1; adv15: number; cur: number; curKind: string;
    varM: number; dblCut: boolean; drift: number | null;
  };
  const rows: R[] = [];
  for (const f of files) {
    const date = f.slice(6, 16);
    const rawAll = JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) as SoxxBar[];
    const raw = rawAll.filter((b) => b.etMin >= SOXX_ET_PRE && b.etMin < SOXX_ET_CLOSE).sort((a, b) => a.etMin - b.etMin);
    const reg = raw.filter((b) => b.etMin >= SOXX_ET_OPEN);
    const hist = daily.filter((x) => x.date < date).slice(-60);
    if (reg.length < 250 || hist.length < 11) continue;
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const j = judgeSoxxDay(date, raw, hist, r10, C.newModel.rebox);
    // F 프리장 선행 진입일만 (8/6 유형)
    if (!j.fJ || j.fJ.t >= SOXX_ET_OPEN || (j.c1 && j.c1.t <= j.fJ.t)) continue;
    const fJ = j.fJ, fdir = fJ.dir;
    const close = reg[reg.length - 1].close;
    const open = reg[0].close;
    const preLast = raw.filter(b => b.etMin < SOXX_ET_OPEN).pop();
    if (!preLast) continue;
    // ① 개장 15분 역행 최대치 (F 방향 기준, 개장가 대비 %)
    const first15 = reg.filter(b => b.etMin < SOXX_ET_OPEN + 15);
    const adv15 = Math.min(...first15.map(b => ((fdir === 1 ? b.low : b.high) - open) / open * 100 * fdir));
    // 현행: E1 — 창1 반대면 그 시점 청산+역진입, 아니면 F 레그 지속(스탑은 개장부터)
    const iOpen = raw.findIndex(b => b.etMin >= SOXX_ET_OPEN);
    const e1 = j.c1 && j.c1.dir !== fdir ? j.c1 : null;
    const e1I = e1 ? raw.findIndex(b => b.etMin === e1.t) : -1;
    // F 레그: 확인가 진입, 스탑 감시는 개장부터 (프리장 스탑 없음 사양) — leg를 개장 인덱스부터 재앵커
    const fLeg = (() => {
      const endI = e1 && e1I >= 0 ? e1I : undefined;
      const r = leg(raw, Math.max(iOpen - 1, 0), fdir, fJ.px, close, endI, e1?.px);
      return r;
    })();
    let cur = fLeg.pnl, dbl = false, drift: number | null = null;
    if (e1 && e1I >= 0) {
      const rLeg = leg(raw, e1I, e1.dir, e1.px, close);
      cur += rLeg.pnl;
      if (fLeg.cut === false && rLeg.cut) {
        // F는 전환 청산(컷 아님)·역레그 컷 → 8/6 유형은 fLeg가 E1 청산가로 손실 확정된 케이스도 포함
      }
      if (rLeg.cut && rLeg.cutI !== null) {
        dbl = true;
        drift = ((close - raw[rLeg.cutI].close) / raw[rLeg.cutI].close) * 100 * fdir; // 2차 컷 후 F 원방향 드리프트
      }
    }
    // ② 변형 M: 프리장 끝 청산 + 09:40 개장 10분 추세 재진입 (스탑 -2%·종가 청산)
    const preExit = ((preLast.close - fJ.px) / fJ.px) * 100 * fdir;
    const i40 = raw.findIndex(b => b.etMin >= SOXX_ET_OPEN + 10);
    let varM = preExit;
    if (i40 >= 0) {
      const dir10: 1 | -1 = raw[i40].close >= open ? 1 : -1;
      varM += leg(raw, i40, dir10, raw[i40].close, close).pnl;
    }
    rows.push({ date, fdir, adv15, cur, curKind: e1 ? "E1전환" : "유지", varM, dblCut: dbl, drift });
  }

  console.log(`F 프리장 선행 진입일 ${rows.length}일 (전체 SOXXM 중)`);
  const d86 = rows.find(r => r.date === "2026-08-06");
  if (d86) console.log(`8/6: F ${d86.fdir === 1 ? "상승" : "하락"} · 개장 15분 역행 ${s2(d86.adv15)}% · 현행 ${s2(d86.cur)}% (${d86.curKind}${d86.dblCut ? "·더블컷" : ""}) · 변형M ${s2(d86.varM)}%${d86.drift !== null ? ` · 2차컷 후 F방향 드리프트 ${s2(d86.drift)}%` : ""}\n`);

  // ① 역행 분포
  console.log(`── ① 개장 15분 F 방향 역행(개장가 대비 최대) 분포 ──`);
  for (const [lb, f] of [["≥ -0.5% (경미)", (a: number) => a > -0.5], ["-0.5 ~ -1%", (a: number) => a <= -0.5 && a > -1], ["-1 ~ -2% (8/6 유형)", (a: number) => a <= -1 && a > -2], ["≤ -2% (스탑 직행)", (a: number) => a <= -2]] as [string, (a: number) => boolean][]) {
    const g = rows.filter(r => f(r.adv15));
    console.log(`  ${lb.padEnd(20)} ${String(g.length).padStart(3)}일 (${pctOf(g.length, rows.length)}%) · 그 날들 현행 합 ${s1(g.reduce((a, r) => a + r.cur, 0))}%p`);
  }

  // ② 변형 비교
  const curTot = rows.reduce((a, r) => a + r.cur, 0);
  const varTot = rows.reduce((a, r) => a + r.varM, 0);
  console.log(`\n── ② 현행 vs '프리장 청산 + 09:40 추세 재진입' (${rows.length}일) ──`);
  console.log(`  현행 (개장 보유·E1 전환)      : 합 ${s1(curTot)}%p · 최악 ${Math.min(...rows.map(r => r.cur)).toFixed(2)}`);
  console.log(`  변형 M (프리장 청산·10분 재진입): 합 ${s1(varTot)}%p · 최악 ${Math.min(...rows.map(r => r.varM)).toFixed(2)}`);

  // ③ 더블컷 후 드리프트
  const dbl = rows.filter(r => r.dblCut && r.drift !== null);
  console.log(`\n── ③ 더블컷(역진입도 컷) ${dbl.length}일 — 2차 컷 이후 종가까지 F 원방향 드리프트 ──`);
  if (dbl.length) {
    const pos = dbl.filter(r => r.drift! > 0).length;
    console.log(`  평균 ${s2(dbl.reduce((a, r) => a + r.drift!, 0) / dbl.length)}% · F 원방향 재개 비율 ${pctOf(pos, dbl.length)}% · 개별: ${dbl.map(r => `${r.date.slice(5)} ${s2(r.drift!)}`).join(" · ")}`);
  }
}
main();
