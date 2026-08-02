// 체인 조건 강화 실측 (사용자 제안 2026-08-02): "뒷봉 시가 ≥ 앞봉 몸통 2/3" → "뒷봉 시가·종가 모두 ≥ 2/3"
//   npx tsx scripts/chain-openclose-variant.ts
// (시가는 높게 출발했는데 종가가 도로 주저앉는 봉을 체인에서 배제 — 하락은 상하 대칭 1/3 이하)
// 대상: ①하닉 6봉 현행 스펙(각도·되돌림·원창6 그대로, 체인 조건만 교체 — 현행 재구현 parity 확인 동봉)
//       ②삼전 6봉 동일 ③삼전 4봉 변형(각도 제거·ss-cw4-variant 규약) 기본형·순전진 1.0/1.5
// 채점: 일 최초 풀판정·전환=반대 풀판정·스탑 하닉 -2.5%/삼전 -1.5%·종가보유/전환청산 병기.

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
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const bmid = (b: MinuteBar) => (b.open + b.close) / 2;
const hlmid = (b: MinuteBar) => (b.high + b.low) / 2;
const DEG = 180 / Math.PI;
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
type Dir = 1 | -1;
type Tr = { i: number; to: "up" | "down"; px: number };

// 체인 연결 판정 — ocBoth: 시가만(현행 false) / 시가·종가 모두(제안 true)
function linkOk(base: MinuteBar, cand: MinuteBar, dir: Dir, ocBoth: boolean): boolean {
  const bLo = Math.min(base.open, base.close), bHi = Math.max(base.open, base.close);
  const thr = dir === 1 ? bLo + (2 / 3) * (bHi - bLo) : bLo + (1 / 3) * (bHi - bLo);
  if (dir === 1) return cand.open >= thr && (!ocBoth || cand.close >= thr);
  return cand.open <= thr && (!ocBoth || cand.close <= thr);
}

function buildChain(bars: MinuteBar[], i: number, dir: Dir, len: number, ocBoth: boolean): number[] | null {
  let poolLen = len;
  if (i + poolLen > bars.length) return null;
  const chain = [i];
  const skipped: number[] = [];
  let j = i + 1;
  while (chain.length < len) {
    if (j >= i + poolLen) return null;
    if (linkOk(bars[chain[chain.length - 1]], bars[j], dir, ocBoth)) chain.push(j);
    else {
      skipped.push(j);
      if (skipped.length > 2) return null;
      if (poolLen < len + 2 && i + poolLen < bars.length) poolLen++;
    }
    j++;
  }
  return chain;
}

// 6봉 원스펙 (candleWindow.judgeAt 재구현 — 체인 조건만 가변)
function judge6(bars: MinuteBar[], i: number, dir: Dir, unit: number[], ocBoth: boolean): number | null {
  const chain = buildChain(bars, i, dir, 6, ocBoth);
  if (!chain) return null;
  let ge40 = 0, flat = 0, midBreak = 0;
  for (let p = 0; p < 5; p++) {
    const a = chain[p], b = chain[p + 1];
    const ang = Math.atan((dir * (bmid(bars[b]) - bmid(bars[a]))) / unit[a]) * DEG;
    if (ang >= 40) ge40++;
    if (Math.abs(ang) <= 10) flat++;
    if (dir === 1 ? bars[b].low < hlmid(bars[a]) : bars[b].high > hlmid(bars[a])) midBreak++;
  }
  if (ge40 < 4 || flat > 0 || midBreak > 1) return null;
  let thin = 0, wrong = 0;
  for (let k = i; k < i + 6; k++) {
    const rng = bars[k].high - bars[k].low;
    const body = Math.abs(bars[k].close - bars[k].open);
    if (rng <= 0 || body < 0.2 * rng) thin++;
    if (dir === 1 ? bars[k].close <= bars[k].open : bars[k].close >= bars[k].open) wrong++;
  }
  if (thin > 1 || wrong > 1) return null;
  return chain[5];
}

// 4봉 변형 (ss-cw4-variant 규약 — 각도 제거·되돌림≤1·원창4 두께≤1·양봉3/4·순전진 netK)
function judge4(bars: MinuteBar[], i: number, dir: Dir, unit: number[], ocBoth: boolean, netK: number): number | null {
  const chain = buildChain(bars, i, dir, 4, ocBoth);
  if (!chain) return null;
  let pull = 0;
  for (let p = 0; p < 3; p++) {
    if (dir === 1 ? bars[chain[p + 1]].low < hlmid(bars[chain[p]]) : bars[chain[p + 1]].high > hlmid(bars[chain[p]])) pull++;
  }
  if (pull > 1) return null;
  let thin = 0, wrong = 0;
  for (let k = i; k < i + 4; k++) {
    const rng = bars[k].high - bars[k].low;
    const body = Math.abs(bars[k].close - bars[k].open);
    if (rng <= 0 || body < 0.2 * rng) thin++;
    if (dir === 1 ? bars[k].close <= bars[k].open : bars[k].close >= bars[k].open) wrong++;
  }
  if (thin > 1 || wrong > 1) return null;
  if (netK > 0 && (bmid(bars[chain[3]]) - bmid(bars[chain[0]])) * dir < netK * unit[i] * 3) return null;
  return chain[3];
}

function stream(bars: MinuteBar[], unit: number[], win: 4 | 6, ocBoth: boolean, netK: number): Tr[] {
  const out: Tr[] = [];
  let st: "none" | "up" | "down" = "none";
  const starts = win === 6 ? [-7, -6, -5] : [-5, -4, -3];
  for (let t = win - 1; t < bars.length; t++) {
    let judged: "up" | "down" | null = null;
    for (const dir of [1, -1] as const) {
      for (const off of starts) {
        const s = t + off;
        if (s < 0) continue;
        const r = win === 6 ? judge6(bars, s, dir, unit, ocBoth) : judge4(bars, s, dir, unit, ocBoth, netK);
        if (r === t) { judged = dir === 1 ? "up" : "down"; break; }
      }
      if (judged) break;
    }
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

function score(days: DayD[], win: 4 | 6, ocBoth: boolean, netK: number, stop: number, label: string): void {
  let entries = 0, wins = 0, holdSum = 0, flipSum = 0, cuts = 0, trTotal = 0;
  const remains: number[] = [], posRatios: number[] = [];
  for (const d of days) {
    const unit = unitArr(d.bars, d.r10);
    const trs = stream(d.bars, unit, win, ocBoth, netK);
    trTotal += trs.length;
    if (!trs.length) continue;
    const e = trs[0];
    entries++;
    const sgn = e.to === "up" ? 1 : -1;
    let cutI: number | null = null;
    for (let k = e.i + 1; k < d.bars.length; k++) {
      const b = d.bars[k];
      if (e.to === "up" ? b.low <= e.px * (1 - stop / 100) : b.high >= e.px * (1 + stop / 100)) { cutI = k; break; }
    }
    const rem = ((d.close - e.px) / e.px) * 100 * sgn;
    const hold = cutI !== null ? -stop : rem;
    if (cutI !== null) cuts++;
    if (hold > 0) wins++;
    holdSum += hold;
    const flip = trs.find((t) => t.i > e.i && t.to !== e.to);
    const cutFirst = cutI !== null && (!flip || cutI <= flip.i);
    flipSum += cutFirst ? -stop : flip ? ((flip.px - e.px) / e.px) * 100 * sgn : hold;
    remains.push(rem);
    let ext = sgn === 1 ? Infinity : -Infinity;
    for (let k = 0; k <= e.i; k++) { const v = sgn === 1 ? d.bars[k].low : d.bars[k].high; if (sgn === 1 ? v < ext : v > ext) ext = v; }
    const consumed = (sgn === 1 ? (e.px - ext) / ext : (ext - e.px) / ext) * 100;
    if (consumed + Math.max(rem, 0) > 0) posRatios.push(consumed / (consumed + Math.max(rem, 0)));
  }
  console.log(`${label}: 진입 ${entries}일·전이 ${trTotal} · 승률 ${entries ? Math.round((100 * wins) / entries) : 0}%·컷 ${cuts} · 종가보유 ${s1(holdSum)}%p·전환청산 ${s1(flipSum)}%p · 잔여중앙 ${Number.isNaN(med(remains)) ? "—" : med(remains).toFixed(2)}%·스윙위치 ${Number.isNaN(med(posRatios)) ? "—" : (med(posRatios) * 100).toFixed(0)}%`);
}

async function main() {
  const hx = await loadDays("000660");
  const ss = await loadDays("005930");
  console.log(`════ 체인 조건: 시가만(현행) vs 시가·종가 모두(제안) — 하닉 ${hx.length}일·삼전 ${ss.length}일 ════`);
  console.log(`\n[하닉 6봉 원스펙 — parity 기준: 진입 135·승률 53%·컷 35·종가보유 +84.0]`);
  score(hx, 6, false, 0, 2.5, "현행(시가만)      ");
  score(hx, 6, true, 0, 2.5, "제안(시가·종가 모두)");
  console.log(`\n[삼전 6봉 원스펙]`);
  score(ss, 6, false, 0, 1.5, "현행(시가만)      ");
  score(ss, 6, true, 0, 1.5, "제안(시가·종가 모두)");
  console.log(`\n[삼전 4봉 변형 (각도 제거)]`);
  score(ss, 4, false, 0, 1.5, "기본형·시가만        ");
  score(ss, 4, true, 0, 1.5, "기본형·시가·종가      ");
  score(ss, 4, false, 1.0, 1.5, "순전진1.0·시가만      ");
  score(ss, 4, true, 1.0, 1.5, "순전진1.0·시가·종가   ");
  score(ss, 4, false, 1.5, 1.5, "순전진1.5·시가만      ");
  score(ss, 4, true, 1.5, 1.5, "순전진1.5·시가·종가   ");
  console.log(`\n주: 시가·종가 조건은 음봉이 앞봉 2/3 아래로 주저앉으면 skip 처리(최대 2회) — 원창 역색봉≤1과는 별개.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
