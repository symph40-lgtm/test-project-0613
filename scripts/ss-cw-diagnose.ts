// 삼전 창판정 부적합의 구체 원인 해부 (사용자 질문 2026-08-01 밤 — "왜 개선이 안 되는지 자세히"):
//   npx tsx scripts/ss-cw-diagnose.ts
// 현행 하닉 스펙(고정눈금 0.5·원창6·전환=풀판정) 그대로 삼전에 적용해 하닉과 대조:
//   ① 성적 재실측 (진입·승률·종가보유 합·스탑 -1.5%(삼전)/-2.5%(하닉))
//   ② 신호 재료: 방향 효율(순이동/경로)·몸통 비율·얇은봉 비율 — "연료 대 노이즈"
//   ③ 6봉 원창(스킵 없이) 조건별 통과율: 시가연결/기울기/되돌림/개별봉 — 어느 관문에서 죽는가
//   ④ 판정된 날의 질: 판정 후 종가까지 잔여 전진 분포 — 스탑 폭 대비 기대 이득
//   ⑤ 최근 2거래일 상세: 판정 유무·시각·결과 (하닉 대조)

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { candleJudgeStream, unitArr } from "../lib/predict/candleWindow";
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
const s2 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;

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

// ③ 원창 6봉(스킵 없이) 조건별 독립 통과 검사 — "어느 관문에서 죽는가"
function windowConds(bars: MinuteBar[], i: number, dir: 1 | -1, unit: number[]): { c1: boolean; c2: boolean; c3: boolean; c4: boolean; medAng: number } | null {
  if (i + 6 > bars.length) return null;
  let c1 = true, ge40 = 0, flat = 0, midBreak = 0, thin = 0, wrong = 0;
  const angs: number[] = [];
  for (let p = 0; p < 5; p++) {
    const a = bars[i + p], b = bars[i + p + 1];
    const bLo = Math.min(a.open, a.close), bHi = Math.max(a.open, a.close);
    if (dir === 1 ? b.open < bLo + (2 / 3) * (bHi - bLo) : b.open > bLo + (1 / 3) * (bHi - bLo)) c1 = false;
    const ang = Math.atan((dir * (bmid(b) - bmid(a))) / unit[i + p]) * DEG;
    angs.push(ang);
    if (ang >= 40) ge40++;
    if (Math.abs(ang) <= 10) flat++;
    if (dir === 1 ? b.low < hlmid(a) : b.high > hlmid(a)) midBreak++;
  }
  for (let k = i; k < i + 6; k++) {
    const rng = bars[k].high - bars[k].low;
    const body = Math.abs(bars[k].close - bars[k].open);
    if (rng <= 0 || body < 0.2 * rng) thin++;
    if (dir === 1 ? bars[k].close <= bars[k].open : bars[k].close >= bars[k].open) wrong++;
  }
  return { c1, c2: ge40 >= 4 && flat === 0, c3: midBreak <= 1, c4: thin <= 1 && wrong <= 1, medAng: med(angs) };
}

async function analyze(code: string, name: string, stopPct: number): Promise<void> {
  const days = await loadDays(code);
  let entries = 0, wins = 0, holdSum = 0, cuts = 0;
  const remains: number[] = []; // 판정가 → 종가 잔여 전진 (판정 방향, %)
  const remainsR10: number[] = []; // 잔여 전진 / r10% (자기 변동성 정규화)
  const posRatios: number[] = []; // 판정 위치 = 소모 / (소모+잔여>0) — 스윙의 몇 % 지점에서 판정이 뜨나
  let maeFirst = 0; // 스탑폭 역행이 스탑폭 순행보다 먼저 온 판정 수
  const effs: number[] = [], bodyR: number[] = [], thinF: number[] = [];
  const conds = { c1: 0, c2: 0, c3: 0, c4: 0, all: 0, n: 0 };
  const lastTwo: string[] = [];
  for (const d of days.slice(-2)) lastTwo.push(d.date);

  for (const d of days) {
    const unit = unitArr(d.bars, d.r10);
    // ② 신호 재료
    let path = 0;
    for (let k = 1; k < d.bars.length; k++) path += Math.abs(d.bars[k].close - d.bars[k - 1].close);
    const net = Math.abs(d.bars[d.bars.length - 1].close - d.bars[0].open);
    if (path > 0) effs.push(net / path);
    const brs = d.bars.map((b) => ({ body: Math.abs(b.close - b.open), rng: b.high - b.low })).filter((x) => x.rng > 0);
    bodyR.push(med(brs.map((x) => x.body / x.rng)));
    thinF.push(brs.filter((x) => x.body < 0.2 * x.rng).length / brs.length);
    // ③ 조건별 통과율 (원창·양방향 중 나은 쪽)
    for (let i = 0; i + 6 <= d.bars.length; i += 3) { // 3봉 간격 샘플링 (연산 절약, 편향 없음)
      let best: ReturnType<typeof windowConds> = null;
      for (const dir of [1, -1] as const) {
        const w = windowConds(d.bars, i, dir, unit);
        if (!w) continue;
        if (!best || Number(w.c1) + Number(w.c2) + Number(w.c3) + Number(w.c4) > Number(best.c1) + Number(best.c2) + Number(best.c3) + Number(best.c4)) best = w;
      }
      if (!best) continue;
      conds.n++;
      if (best.c1) conds.c1++;
      if (best.c2) conds.c2++;
      if (best.c3) conds.c3++;
      if (best.c4) conds.c4++;
      if (best.c1 && best.c2 && best.c3 && best.c4) conds.all++;
    }
    // ① 성적 (일 최초 풀판정·종가보유·스탑)
    const trs = candleJudgeStream(d.bars, unit);
    if (trs.length) {
      const e = trs[0];
      entries++;
      const sgn = e.to === "up" ? 1 : -1;
      let cut = false;
      for (let k = e.i + 1; k < d.bars.length; k++) {
        const b = d.bars[k];
        if (e.to === "up" ? b.low <= e.px * (1 - stopPct / 100) : b.high >= e.px * (1 + stopPct / 100)) { cut = true; break; }
      }
      const pnl = cut ? -stopPct : ((d.close - e.px) / e.px) * 100 * sgn;
      if (cut) cuts++;
      if (pnl > 0) wins++;
      holdSum += pnl;
      const rem = ((d.close - e.px) / e.px) * 100 * sgn;
      remains.push(rem);
      remainsR10.push(rem / ((d.r10 / e.px) * 100));
      // 극점(판정 전 최저저가/최고고가) → 판정까지 소모, 스윙 내 위치
      let ext = sgn === 1 ? Infinity : -Infinity;
      for (let k = 0; k <= e.i; k++) { const v = sgn === 1 ? d.bars[k].low : d.bars[k].high; if (sgn === 1 ? v < ext : v > ext) ext = v; }
      const consumed = (sgn === 1 ? (e.px - ext) / ext : (ext - e.px) / ext) * 100;
      if (consumed + Math.max(rem, 0) > 0) posRatios.push(consumed / (consumed + Math.max(rem, 0)));
      // 경로: 스탑폭 역행과 스탑폭 순행 중 무엇이 먼저인가
      for (let k = e.i + 1; k < d.bars.length; k++) {
        const b = d.bars[k];
        const adv = sgn === 1 ? (b.high - e.px) / e.px : (e.px - b.low) / e.px;
        const bad = sgn === 1 ? (e.px - b.low) / e.px : (b.high - e.px) / e.px;
        if (bad >= stopPct / 100) { maeFirst++; break; }
        if (adv >= stopPct / 100) break;
      }
    }
    // ⑤ 최근 2거래일 상세
    if (lastTwo.includes(d.date)) {
      if (trs.length) {
        const e = trs[0];
        const sgn = e.to === "up" ? 1 : -1;
        const rem = ((d.close - e.px) / e.px) * 100 * sgn;
        console.log(`  [${d.date}] ${name}: ${d.bars[e.i].time} ${e.to === "up" ? "상승" : "하락"} 판정 ${e.px.toLocaleString()}원 → 종가 잔여 ${s2(rem)}% (전이 총 ${trs.length}회)`);
      } else {
        // 가장 아까웠던 창: 3/4 조건 통과 창 수
        let near = 0;
        for (let i = 0; i + 6 <= d.bars.length; i++) {
          for (const dir of [1, -1] as const) {
            const w = windowConds(d.bars, i, dir, unit);
            if (w && Number(w.c1) + Number(w.c2) + Number(w.c3) + Number(w.c4) === 3) { near++; break; }
          }
        }
        console.log(`  [${d.date}] ${name}: 판정 없음 — 4조건 중 3개까지 통과한 창 ${near}개 (마지막 관문에서 전부 탈락)`);
      }
    }
  }
  const pctOf = (x: number) => `${Math.round((100 * x) / conds.n)}%`;
  console.log(`\n════ ${name} — ${days.length}일 (스탑 본주 -${stopPct}%) ════`);
  console.log(`① 성적: 진입 ${entries}일 · 승률 ${entries ? Math.round((100 * wins) / entries) : 0}% · 컷 ${cuts} · 종가보유 합 ${s2(holdSum)}%p`);
  console.log(`② 재료: 방향 효율(순이동/경로) 중앙 ${med(effs).toFixed(3)} · 봉 몸통/폭 중앙 ${med(bodyR).toFixed(2)} · 얇은봉(몸통<20%) 비율 중앙 ${(med(thinF) * 100).toFixed(0)}%`);
  console.log(`③ 6봉 원창 조건별 통과율 (${conds.n.toLocaleString()}창): 시가연결 ${pctOf(conds.c1)} · 기울기40° ${pctOf(conds.c2)} · 되돌림 ${pctOf(conds.c3)} · 개별봉 ${pctOf(conds.c4)} · 전부 ${pctOf(conds.all)}`);
  if (remains.length) {
    const geStop = remains.filter((r) => r >= stopPct).length;
    console.log(`④ 판정의 질: 판정가→종가 잔여 전진 중앙 ${s2(med(remains))}% · 평균 ${s2(remains.reduce((a, b) => a + b, 0) / remains.length)}% · 잔여≥스탑폭(${stopPct}%) 비율 ${Math.round((100 * geStop) / remains.length)}%`);
    console.log(`   정규화: 잔여/자기r10 중앙 ${s2(med(remainsR10))} · 판정의 스윙 내 위치 중앙 ${(med(posRatios) * 100).toFixed(0)}%(뒤일수록 소진 후 판정) · 스탑폭 역행이 순행보다 먼저 ${Math.round((100 * maeFirst) / entries)}%`);
  }
}

async function main() {
  console.log("[최근 2거래일 상세]");
  await analyze("000660", "하닉", 2.5);
  await analyze("005930", "삼전", 1.5);
  console.log(`\n주: 조건 검사는 스킵 보정 없는 원창 샘플링(3봉 간격) — 판정 스트림(스킵 포함)보다 보수적이나 두 종목 동일 잣대.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
