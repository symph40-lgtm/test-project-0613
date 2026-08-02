// 삼전 찐레그(일중 스윙 ≥5%/6%) 한정 — 4봉 전진 문턱 최적값 스윕 (사용자 지시 2026-08-02):
//   npx tsx scripts/ss-cw4-bigleg-sweep.ts
// 레그 = 일중 양 극점 간 최대 스윙 (상승: 저점→이후 고점 최대 / 하락: 고점→이후 저점 최대, 본주 %).
// 지배 레그 방향의 스윙이 문턱(5%·6%) 이상인 날만 골라, 누적 순전진(cum)·쌍별 전진(pair)의
// tan 문턱을 훑는다. 각 셀에서 함께 보는 것:
//   커버 = 해당일 중 첫 판정이 지배 레그와 같은 방향인 날 비율 · 진입 시 스윙 소모율(위치)
//   해당일 종가보유 합 / 비해당일 합 (노이즈 비용 — 라이브는 그날 유형을 미리 모름) / 전체 합
// 채점 규약은 ss-cw4-pure-advance와 동일 (일 최초 판정·스탑 -1.5%·종가보유).

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { unitArr } from "../lib/predict/candleWindow";
import type { MinuteBar } from "../lib/predict/types";

const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const rc = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const bmid = (b: MinuteBar) => (b.open + b.close) / 2;
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
type Tr = { i: number; to: "up" | "down"; px: number };

function judgePure(bars: MinuteBar[], t: number, unit: number[], mode: "cum" | "pair", tanA: number): "up" | "down" | null {
  if (t < 3) return null;
  const i = t - 3;
  for (const dir of [1, -1] as const) {
    let ok: boolean;
    if (mode === "cum") ok = (bmid(bars[t]) - bmid(bars[i])) * dir >= tanA * unit[i] * 3;
    else {
      ok = true;
      for (let p = 0; p < 3; p++) {
        if ((bmid(bars[i + p + 1]) - bmid(bars[i + p])) * dir < tanA * unit[i + p]) { ok = false; break; }
      }
    }
    if (ok) return dir === 1 ? "up" : "down";
  }
  return null;
}
function streamPure(bars: MinuteBar[], unit: number[], mode: "cum" | "pair", tanA: number): Tr[] {
  const out: Tr[] = [];
  let st: "none" | "up" | "down" = "none";
  for (let t = 3; t < bars.length; t++) {
    const judged = judgePure(bars, t, unit, mode, tanA);
    if (!judged) continue;
    if (st === "none" || judged !== st) { st = judged; out.push({ i: t, to: st, px: bars[t].close }); }
  }
  return out;
}

// 일중 지배 레그: 상승 스윙(저점→이후 고점)·하락 스윙(고점→이후 저점)의 최대 (본주 %)
function daySwing(bars: MinuteBar[]): { up: number; dn: number } {
  let minLow = Infinity, maxHigh = -Infinity, up = 0, dn = 0;
  for (const b of bars) {
    minLow = Math.min(minLow, b.low);
    maxHigh = Math.max(maxHigh, b.high);
    up = Math.max(up, ((b.high - minLow) / minLow) * 100);
    dn = Math.max(dn, ((maxHigh - b.low) / maxHigh) * 100);
  }
  return { up, dn };
}

type DayD = { date: string; bars: MinuteBar[]; r10: number; close: number; sw: { up: number; dn: number } };
async function loadDays(code: string): Promise<DayD[]> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, 500)).filter((b) => b.date < today);
  const out: DayD[] = [];
  for (let i = 130; i < daily.length; i++) {
    const reg = rc(`${code}-${daily[i].date}.json`);
    const pre = rc(`${code}NX-${daily[i].date}.json`);
    const hist = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (!reg || reg.length < 240 || r10 === null) continue;
    const bars = [...(pre ?? []), ...reg];
    out.push({ date: daily[i].date, bars, r10, close: daily[i].close, sw: daySwing(bars) });
  }
  return out;
}

const STOP = 1.5;
function cell(days: DayD[], mode: "cum" | "pair", tanA: number, minSwing: number): string {
  let bigN = 0, cover = 0, bigSum = 0, bigCuts = 0, smallSum = 0, smallCuts = 0, bigWins = 0, bigEntries = 0;
  const entryPos: number[] = [];
  for (const d of days) {
    const domDir = d.sw.up >= d.sw.dn ? 1 : -1;
    const domSw = Math.max(d.sw.up, d.sw.dn);
    const isBig = domSw >= minSwing;
    if (isBig) bigN++;
    const unit = unitArr(d.bars, d.r10);
    const trs = streamPure(d.bars, unit, mode, tanA);
    if (!trs.length) continue;
    const e = trs[0];
    const sgn = e.to === "up" ? 1 : -1;
    let cut = false;
    for (let k = e.i + 1; k < d.bars.length; k++) {
      const b = d.bars[k];
      if (e.to === "up" ? b.low <= e.px * (1 - STOP / 100) : b.high >= e.px * (1 + STOP / 100)) { cut = true; break; }
    }
    const pnl = cut ? -STOP : ((d.close - e.px) / e.px) * 100 * sgn;
    if (isBig) {
      bigEntries++;
      bigSum += pnl;
      if (cut) bigCuts++;
      if (pnl > 0) bigWins++;
      if (sgn === domDir) {
        cover++;
        // 진입 시점까지 지배 레그가 이미 소모된 비율 (극점→진입가 / 전체 스윙)
        let ext = sgn === 1 ? Infinity : -Infinity;
        for (let k = 0; k <= e.i; k++) { const v = sgn === 1 ? d.bars[k].low : d.bars[k].high; if (sgn === 1 ? v < ext : v > ext) ext = v; }
        const consumed = (sgn === 1 ? (e.px - ext) / ext : (ext - e.px) / ext) * 100;
        entryPos.push(Math.min(1, Math.max(0, consumed / domSw)));
      }
    } else {
      smallSum += pnl;
      if (cut) smallCuts++;
    }
  }
  const posM = med(entryPos);
  return `해당 ${bigN}일: 커버 ${bigN ? Math.round((100 * cover) / bigN) : 0}%·방향적중 ${bigEntries ? Math.round((100 * bigWins) / bigEntries) : 0}%·진입위치 ${Number.isNaN(posM) ? "—" : `${Math.round(posM * 100)}%`} · 해당일 합 ${s1(bigSum)}(컷 ${bigCuts}) · 비해당일 합 ${s1(smallSum)}(컷 ${smallCuts}) · 전체 ${s1(bigSum + smallSum)}%p`;
}

async function main() {
  const ss = await loadDays("005930");
  const T = [0.5, 0.7, 0.84, 1.0, 1.2, 1.5, 2.0];
  for (const minSw of [5, 6]) {
    const bigN = ss.filter((d) => Math.max(d.sw.up, d.sw.dn) >= minSw).length;
    console.log(`\n════ 삼전 ${ss.length}일 중 찐레그(일중 스윙 ≥${minSw}%) ${bigN}일 ════`);
    console.log(`[누적 순전진 — 문턱 ×눈금×3쌍]`);
    for (const t of T) console.log(`  ${t.toFixed(2)}${t === 0.84 ? "(40°)" : t === 1.0 ? "(45°)" : "     "}: ${cell(ss, "cum", t, minSw)}`);
    console.log(`[쌍별 전진 — 3쌍 모두 ×눈금]`);
    for (const t of T) console.log(`  ${t.toFixed(2)}${t === 0.84 ? "(40°)" : t === 1.0 ? "(45°)" : "     "}: ${cell(ss, "pair", t, minSw)}`);
  }
  console.log(`\n주: 커버 = 해당일 중 첫 판정이 지배 레그 방향인 날. 진입위치 = 진입 시점까지 스윙 소모율 중앙.`);
  console.log(`    라이브는 그날 유형을 모름 — 최적값은 [해당일 합]과 [비해당일 합]을 함께 봐야 함.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
