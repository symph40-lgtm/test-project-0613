// 삼전 4봉 "전진 조건만" 최소 모델 실측 (사용자 제안 2026-08-02 — 조건 2개만):
//   npx tsx scripts/ss-cw4-pure-advance.ts
// A) 4봉 + 누적 순전진: 첫→넷째 봉 몸통중간 전진 ≥ tan(각도)×눈금×3쌍  (다른 조건 전무·skip 없음)
// B) 4봉 + 쌍별 전진: 인접 3쌍 각각 전진 ≥ tan(각도)×눈금  (= 각봉 모두 40° — 다른 조건 전무)
// 각도 40°(제안)·45°(참고). 눈금 = 직전 30봉 평균 고저폭×0.5 (unitArr — 하닉 창판정과 동일).
// 대조: 무신호 상승편향(매일 09시 롱+스탑) +51.6 · 이전 최고 셀(순전진1.0+시가·종가+형태조건) +76.7.

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
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const fmtT = (m: number) => Number.isNaN(m) ? "—" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const bmid = (b: MinuteBar) => (b.open + b.close) / 2;
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
type Tr = { i: number; to: "up" | "down"; px: number };

// 창 [t-3..t] 하나만 검사 (시가연결·skip 없음 — 연속 4봉)
function judgePure(bars: MinuteBar[], t: number, unit: number[], mode: "cum" | "pair", tanA: number): "up" | "down" | null {
  if (t < 3) return null;
  const i = t - 3;
  for (const dir of [1, -1] as const) {
    let ok: boolean;
    if (mode === "cum") {
      ok = (bmid(bars[t]) - bmid(bars[i])) * dir >= tanA * unit[i] * 3;
    } else {
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

type DayD = { date: string; bars: MinuteBar[]; r10: number; close: number };
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
    out.push({ date: daily[i].date, bars: [...(pre ?? []), ...reg], r10, close: daily[i].close });
  }
  return out;
}

const STOP = 1.5;
function score(days: DayD[], mode: "cum" | "pair", tanA: number, label: string): void {
  let entries = 0, wins = 0, holdSum = 0, flipSum = 0, cuts = 0, trTotal = 0;
  const remains: number[] = [], posRatios: number[] = [], firsts: number[] = [];
  for (const d of days) {
    const unit = unitArr(d.bars, d.r10);
    const trs = streamPure(d.bars, unit, mode, tanA);
    trTotal += trs.length;
    if (!trs.length) continue;
    const e = trs[0];
    entries++;
    const sgn = e.to === "up" ? 1 : -1;
    firsts.push(tMin(d.bars[e.i].time));
    let cutI: number | null = null;
    for (let k = e.i + 1; k < d.bars.length; k++) {
      const b = d.bars[k];
      if (e.to === "up" ? b.low <= e.px * (1 - STOP / 100) : b.high >= e.px * (1 + STOP / 100)) { cutI = k; break; }
    }
    const rem = ((d.close - e.px) / e.px) * 100 * sgn;
    const hold = cutI !== null ? -STOP : rem;
    if (cutI !== null) cuts++;
    if (hold > 0) wins++;
    holdSum += hold;
    const flip = trs.find((t) => t.i > e.i && t.to !== e.to);
    const cutFirst = cutI !== null && (!flip || cutI <= flip.i);
    flipSum += cutFirst ? -STOP : flip ? ((flip.px - e.px) / e.px) * 100 * sgn : hold;
    remains.push(rem);
    let ext = sgn === 1 ? Infinity : -Infinity;
    for (let k = 0; k <= e.i; k++) { const v = sgn === 1 ? d.bars[k].low : d.bars[k].high; if (sgn === 1 ? v < ext : v > ext) ext = v; }
    const consumed = (sgn === 1 ? (e.px - ext) / ext : (ext - e.px) / ext) * 100;
    if (consumed + Math.max(rem, 0) > 0) posRatios.push(consumed / (consumed + Math.max(rem, 0)));
  }
  console.log(`${label}: 진입 ${entries}일·전이 ${trTotal} · 승률 ${entries ? Math.round((100 * wins) / entries) : 0}%·컷 ${cuts} · 종가보유 ${s1(holdSum)}%p·전환청산 ${s1(flipSum)}%p · 잔여중앙 ${Number.isNaN(med(remains)) ? "—" : med(remains).toFixed(2)}%·스윙위치 ${Number.isNaN(med(posRatios)) ? "—" : (med(posRatios) * 100).toFixed(0)}%·첫판정 ${fmtT(med(firsts))}`);
}

async function main() {
  const ss = await loadDays("005930");
  const T40 = Math.tan((40 * Math.PI) / 180); // 0.839
  console.log(`════ 삼전 4봉 "전진 조건만" 최소 모델 — ${ss.length}일·스탑 -${STOP}% ════`);
  console.log(`대조: 무신호 상승편향 +51.6%p·컷 105 / 이전 최고 셀(순전진1.0+시가·종가+형태) +76.7%p·승률 45%`);
  console.log(`\n[A] 누적 순전진 (첫→넷째 몸통중간 ≥ tan×눈금×3)`);
  score(ss, "cum", T40, "40°");
  score(ss, "cum", 1.0, "45°");
  console.log(`\n[B] 쌍별 전진 — 3쌍 모두 (각봉 전진 ≥ tan×눈금)`);
  score(ss, "pair", T40, "40°");
  score(ss, "pair", 1.0, "45°");
}
main().catch((e) => { console.error(e); process.exit(1); });
