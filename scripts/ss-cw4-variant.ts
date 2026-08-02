// 삼전 전용 4봉 변형 창판정 실측 (사용자 설계 2026-08-01 밤):
//   npx tsx scripts/ss-cw4-variant.ts
// 설계 (사용자 지정): 4봉 창 — 3개 인접쌍 전부 "비교봉 시가 ≥ 기준봉 몸통(시가~종가)의 2/3 지점"
//   (하락 대칭 1/3 아래) · skip ≤2(우측 5·6번봉 보충 — 6봉판과 동일 규약) · 두께(몸통<20%폭) ≤1 ·
//   양봉 4중 3(역색 ≤1) · 되돌림(저점<이전봉 고저중간) ≤1 · **각도 조건 제거** ("시가 2/3 연결이
//   계단을 강제하니 각도는 불필요" — 사용자 가설).
// 각도 제거로 노이즈가 늘면 조일 후보를 격자로: 되돌림 0회 / 두께 0개 / 양봉 4/4 / 순전진(각도의
//   누적 대체 — 창 몸통중간 순전진 ≥ k×눈금×3쌍) / 진행성 게이트(판정+5분 전진 ≥0.1×r10).
// 채점: 일 최초 풀판정 진입 · 전환=반대 풀판정 · 스탑 본주 -1.5%(삼전) · 종가보유/전환청산 병기.
// 대조: 삼전 6봉 원스펙(-14.8%p·승률 38%) · 하닉 6봉 원스펙(+84.0%p·53%).

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
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;

type Dir = 1 | -1;
type Opts = {
  pullMax: number;   // 되돌림 허용 (기본 1 → 조임 0)
  thinMax: number;   // 얇은봉 허용 (기본 1 → 조임 0)
  wrongMax: number;  // 역색봉 허용 (기본 1 = 양봉 3/4 → 조임 0 = 4/4)
  netK: number;      // 순전진 ≥ netK × unit × 3쌍 (0 = 비활성. 참고: 각도 40°≈0.84/쌍·45°=1.0/쌍)
  prog5: boolean;    // 판정 후 5분 전진 ≥ 0.1×r10 게이트 (진입 = 5봉째 종가 — 실전 동일)
  fromHHMM?: string; // 이 시각 이전 완성 판정 무시 (삼전 프리장 저유동 의심 검증용)
};
const BASE: Opts = { pullMax: 1, thinMax: 1, wrongMax: 1, netK: 0, prog5: false };

// 4봉 체인: 시가 2/3 연결, skip ≤2 (우측 보충 — 6봉판 buildChain과 동일 규약을 4봉으로)
function chain4(bars: MinuteBar[], i: number, dir: Dir): number[] | null {
  let poolLen = 4;
  if (i + poolLen > bars.length) return null;
  const chain = [i];
  const skipped: number[] = [];
  let j = i + 1;
  while (chain.length < 4) {
    if (j >= i + poolLen) return null;
    const base = bars[chain[chain.length - 1]], cand = bars[j];
    const bLo = Math.min(base.open, base.close), bHi = Math.max(base.open, base.close);
    const ok = dir === 1 ? cand.open >= bLo + (2 / 3) * (bHi - bLo) : cand.open <= bLo + (1 / 3) * (bHi - bLo);
    if (ok) chain.push(j);
    else {
      skipped.push(j);
      if (skipped.length > 2) return null;
      if (poolLen < 6 && i + poolLen < bars.length) poolLen++;
    }
    j++;
  }
  return chain;
}

function judgeAt4(bars: MinuteBar[], i: number, dir: Dir, unit: number[], o: Opts): number | null {
  const chain = chain4(bars, i, dir);
  if (!chain) return null;
  let pull = 0;
  for (let p = 0; p < 3; p++) {
    const a = bars[chain[p]], b = bars[chain[p + 1]];
    if (dir === 1 ? b.low < hlmid(a) : b.high > hlmid(a)) pull++;
  }
  if (pull > o.pullMax) return null;
  let thin = 0, wrong = 0;
  for (let k = i; k < i + 4; k++) { // 개별 봉 조건은 원창 4봉 (6봉판의 '원창' 규약 동일)
    const rng = bars[k].high - bars[k].low;
    const body = Math.abs(bars[k].close - bars[k].open);
    if (rng <= 0 || body < 0.2 * rng) thin++;
    if (dir === 1 ? bars[k].close <= bars[k].open : bars[k].close >= bars[k].open) wrong++;
  }
  if (thin > o.thinMax || wrong > o.wrongMax) return null;
  if (o.netK > 0) {
    const net = (bmid(bars[chain[3]]) - bmid(bars[chain[0]])) * dir;
    if (net < o.netK * unit[i] * 3) return null;
  }
  return chain[3];
}

type Tr = { i: number; to: "up" | "down"; px: number };
function stream4(bars: MinuteBar[], unit: number[], o: Opts): Tr[] {
  const out: Tr[] = [];
  let st: "none" | "up" | "down" = "none";
  for (let t = 3; t < bars.length; t++) {
    let judged: "up" | "down" | null = null;
    for (const dir of [1, -1] as const) {
      for (const start of [t - 5, t - 4, t - 3]) {
        if (start < 0) continue;
        if (judgeAt4(bars, start, dir, unit, o) === t) { judged = dir === 1 ? "up" : "down"; break; }
      }
      if (judged) break;
    }
    if (!judged) continue;
    if (o.fromHHMM && bars[t].time < o.fromHHMM) continue;
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

const STOP = 1.5; // 삼전 본주
function score(days: DayD[], o: Opts, label: string, detail = false): { hold: number } {
  let entries = 0, wins = 0, holdSum = 0, flipSum = 0, cuts = 0, trTotal = 0;
  const remains: number[] = [], posRatios: number[] = [], firsts: number[] = [];
  for (const d of days) {
    const unit = unitArr(d.bars, d.r10);
    const trs = stream4(d.bars, unit, o);
    trTotal += trs.length;
    if (!trs.length) continue;
    let e = trs[0];
    let entryI = e.i, entryPx = e.px;
    if (o.prog5) { // 진행성 게이트: 5분 뒤 전진 충족한 첫 판정만 유효 — 진입은 실전대로 5봉째 종가
      let found: Tr | null = null;
      for (const t of trs) {
        if (t.i + 5 >= d.bars.length) break;
        const sgn = t.to === "up" ? 1 : -1;
        if ((d.bars[t.i + 5].close - t.px) * sgn >= 0.1 * d.r10) { found = t; break; }
      }
      if (!found) continue;
      e = found;
      entryI = e.i + 5;
      entryPx = d.bars[entryI].close;
    }
    entries++;
    const sgn = e.to === "up" ? 1 : -1;
    firsts.push(tMin(d.bars[entryI].time));
    let cutI: number | null = null;
    for (let k = entryI + 1; k < d.bars.length; k++) {
      const b = d.bars[k];
      if (e.to === "up" ? b.low <= entryPx * (1 - STOP / 100) : b.high >= entryPx * (1 + STOP / 100)) { cutI = k; break; }
    }
    const rem = ((d.close - entryPx) / entryPx) * 100 * sgn;
    const hold = cutI !== null ? -STOP : rem;
    if (cutI !== null) cuts++;
    if (hold > 0) wins++;
    holdSum += hold;
    const flip = trs.find((t) => t.i > entryI && t.to !== e.to);
    const cutFirst = cutI !== null && (!flip || cutI <= flip.i);
    flipSum += cutFirst ? -STOP : flip ? ((flip.px - entryPx) / entryPx) * 100 * sgn : hold;
    remains.push(rem);
    let ext = sgn === 1 ? Infinity : -Infinity;
    for (let k = 0; k <= entryI; k++) { const v = sgn === 1 ? d.bars[k].low : d.bars[k].high; if (sgn === 1 ? v < ext : v > ext) ext = v; }
    const consumed = (sgn === 1 ? (entryPx - ext) / ext : (ext - entryPx) / ext) * 100;
    if (consumed + Math.max(rem, 0) > 0) posRatios.push(consumed / (consumed + Math.max(rem, 0)));
  }
  const fmtT = (m: number) => Number.isNaN(m) ? "—" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  console.log(`${label}: 진입 ${entries}일·전이 ${trTotal} · 승률 ${entries ? Math.round((100 * wins) / entries) : 0}%·컷 ${cuts} · 종가보유 ${s2(holdSum)}%p·전환청산 ${s2(flipSum)}%p` +
    (detail ? ` · 잔여중앙 ${Number.isNaN(med(remains)) ? "—" : med(remains).toFixed(2)}%·스윙위치 ${Number.isNaN(med(posRatios)) ? "—" : (med(posRatios) * 100).toFixed(0)}%·첫판정 ${fmtT(med(firsts))}` : ""));
  return { hold: holdSum };
}

async function main() {
  const ss = await loadDays("005930");
  const hx = await loadDays("000660");
  console.log(`════ 삼전 4봉 변형 (사용자 설계 — 각도 제거·양봉 3/4) · ${ss.length}일 · 스탑 -${STOP}% ════`);
  console.log(`대조: 삼전 6봉 원스펙 -14.8%p(승률 38%·컷 61) · 하닉 6봉 원스펙 +84.0%p(53%·35)`);
  console.log(`\n[1] 기본형`);
  score(ss, BASE, "삼전 4봉 기본형", true);
  score(hx, BASE, "(참고) 하닉 4봉 기본형", true);
  console.log(`\n[2] 조임 후보 — 한 가지씩`);
  score(ss, { ...BASE, pullMax: 0 }, "되돌림 0회      ");
  score(ss, { ...BASE, thinMax: 0 }, "두께: 얇은봉 0개");
  score(ss, { ...BASE, wrongMax: 0 }, "양봉 4/4        ");
  score(ss, { ...BASE, netK: 0.5 }, "순전진 ≥0.5×눈금/쌍");
  score(ss, { ...BASE, netK: 0.84 }, "순전진 ≥0.84×눈금/쌍(≈40°)");
  score(ss, { ...BASE, netK: 1.0 }, "순전진 ≥1.0×눈금/쌍(=45°)", true);
  score(ss, { ...BASE, netK: 1.2 }, "순전진 ≥1.2×눈금/쌍");
  score(ss, { ...BASE, netK: 1.5 }, "순전진 ≥1.5×눈금/쌍");
  score(ss, { ...BASE, netK: 1.0, fromHHMM: "09:00" }, "순전진1.0 + 09시 게이트");
  score(ss, { ...BASE, prog5: true }, "진행성 5분 게이트");
  console.log(`\n[3] 조합 (2단 조임)`);
  score(ss, { ...BASE, pullMax: 0, wrongMax: 0 }, "되돌림0 + 양봉4/4");
  score(ss, { ...BASE, pullMax: 0, prog5: true }, "되돌림0 + 진행성");
  score(ss, { ...BASE, wrongMax: 0, prog5: true }, "양봉4/4 + 진행성");
  score(ss, { ...BASE, netK: 0.5, prog5: true }, "순전진0.5 + 진행성");
  score(ss, { ...BASE, pullMax: 0, wrongMax: 0, prog5: true }, "되돌림0+양봉4/4+진행성");

  // 상승 편향 대조군: 매일 09:00 시가 롱 + 스탑 -1.5% + 종가 청산 (신호 없는 홀드가 얼마나 버나)
  let biasSum = 0, biasCuts = 0;
  for (const d of ss) {
    const reg = d.bars.filter((b) => b.time >= "09:00");
    if (!reg.length) continue;
    const e = reg[0].open;
    let cut = false;
    for (const b of reg) { if (b.low <= e * (1 - STOP / 100)) { cut = true; break; } }
    biasSum += cut ? -STOP : ((d.close - e) / e) * 100;
    if (cut) biasCuts++;
  }
  console.log(`\n[대조군] 매일 09:00 시가 롱+스탑-1.5%+종가청산: ${s2(biasSum)}%p · 컷 ${biasCuts} — 신호 없는 상승 편향의 크기`);
}
main().catch((e) => { console.error(e); process.exit(1); });
