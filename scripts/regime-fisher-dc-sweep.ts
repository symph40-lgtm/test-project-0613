// 레짐(4분면) × 피셔 × DC1·DC2 3층 보완 실측 (사용자 요청 2026-07-26 — "레짐·피셔와 함께
// DC1·DC2를 보완적으로 써서 추세판정·수익에 도움이 되는지, 어떤 식으로 보완하면 좋은지").
//   npx tsx scripts/regime-fisher-dc-sweep.ts   (.predict-cache 전용 — 무통신)
//
// 층위: ①장전 레짐 Q1~Q4 (lib/predict/regime.ts와 동일 — vol10 추적 66.7분위 × 전일 추세일)
//      ②장중 피셔 레그 (F 08연속창 0.05·4·sb·rev3 / 본 09창 0.15·8·sb·rev3, 스탑 -1.5%)
//      ③확인 시점 DC (60분 롤링: DC1 = 방향 일치 5분청크 비율 · DC2 = 순이동/총이동)
// 질문: (a) Q가 피셔 성적을 가르는가 — "Q1·Q3(전일추세)가 이익내기 좋은 날"의 피셔 검증
//      (b) Q 조건부로 DC2(효율)·DC1(소진) 게이트가 추가 분리를 주는가
// 채택 기준: 두 종목·전후반 일관 분리만 문자 반영 후보.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { avgRange, isHighVolDay } from "../lib/predict/indicators";
import { labelDay } from "../lib/predict/label";
import { fetchDailyPredict } from "../lib/predict/data";
import type { MinuteBar } from "../lib/predict/types";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const readCache = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const STOP = 1.5;

type St = "none" | "up" | "down";
type Trans = { to: St; px: number; idx: number };
function stream(bars: MinuteBar[], orN: number, offW: number, confirm: number, reversal: number, sbW: number): Trans[] {
  if (bars.length < orN + 1) return [];
  const or = bars.slice(0, orN);
  const aUp = Math.max(...or.map((b) => b.high)) + offW;
  const aDn = Math.min(...or.map((b) => b.low)) - offW;
  const out: Trans[] = [];
  let st: St = "none", up = 0, dn = 0;
  for (let i = orN; i < bars.length; i++) {
    const b = bars[i];
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (sbW > 0) {
      if (b.close > aUp + sbW) up = Math.max(up, confirm, reversal);
      if (b.close < aDn - sbW) dn = Math.max(dn, confirm, reversal);
    }
    if (st === "none") {
      if (up >= confirm) { st = "up"; out.push({ to: st, px: b.close, idx: i }); }
      else if (dn >= confirm) { st = "down"; out.push({ to: st, px: b.close, idx: i }); }
    } else if (st === "up" && dn >= reversal) { st = "down"; out.push({ to: st, px: b.close, idx: i }); }
    else if (st === "down" && up >= reversal) { st = "up"; out.push({ to: st, px: b.close, idx: i }); }
  }
  return out;
}
function dcAt(bars: MinuteBar[], idx: number, dir: St, winMin: number): { dc1: number; dc2: number } | null {
  const from = idx - winMin + 1;
  if (from < 0) return null;
  const w = bars.slice(from, idx + 1);
  const ch: { o: number; c: number }[] = [];
  for (let i = 0; i + 5 <= w.length; i += 5) ch.push({ o: w[i].open, c: w[i + 4].close });
  if (ch.length < winMin / 5) return null;
  const sign = dir === "up" ? 1 : -1;
  const dc1 = ch.filter((x) => Math.sign(x.c - x.o) === sign).length / ch.length;
  const path = ch.reduce((s, x) => s + Math.abs(x.c - x.o), 0);
  const dc2 = path > 0 ? Math.abs(w[w.length - 1].close - w[0].open) / path : 0;
  return { dc1, dc2 };
}

type Leg = { pnl: number; q: 1 | 2 | 3 | 4; tier: "F" | "B"; dc1: number | null; dc2: number | null; half: 0 | 1 };

async function collect(code: string, sb: number): Promise<{ legs: Leg[]; qDays: number[] }> {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, 364)).filter((b) => b.date < today);
  const dates = daily.slice(-224).map((b) => b.date).filter((d) => (readCache(`${code}-${d}.json`)?.length ?? 0) >= 240);
  const legs: Leg[] = [];
  const qDays = [0, 0, 0, 0, 0];
  for (const d of dates) {
    const i = daily.findIndex((b) => b.date === d);
    if (i < 90) continue;
    const r10 = avgRange(daily.slice(Math.max(0, i - 120), i), 10);
    if (r10 === null) continue;
    const hv = isHighVolDay(daily.slice(0, i));
    const trend = labelDay(daily[i - 1]).label !== "none";
    const q = (hv ? (trend ? 3 : 4) : trend ? 1 : 2) as 1 | 2 | 3 | 4;
    qDays[q]++;
    const half: 0 | 1 = dates.indexOf(d) < dates.length / 2 ? 0 : 1;
    const reg = readCache(`${code}-${d}.json`)!;
    const pre = readCache(`${code}NX-${d}.json`) ?? [];
    const cont = [...pre, ...reg];
    for (const [tier, bars, ts] of [
      ["F", cont, stream(cont, 15, 0.05 * r10, 4, 3, sb * r10)],
      ["B", reg, stream(reg, 15, 0.15 * r10, 8, 3, sb * r10)],
    ] as const) {
      for (let k = 0; k < ts.length; k++) {
        const t = ts[k];
        const endIdx = k + 1 < ts.length ? ts[k + 1].idx : bars.length - 1;
        const dirUp = t.to === "up";
        let pnl: number | null = null;
        for (let j = t.idx + 1; j <= endIdx; j++) {
          const adv = dirUp ? ((bars[j].low - t.px) / t.px) * 100 : ((t.px - bars[j].high) / t.px) * 100;
          if (adv <= -STOP) { pnl = -STOP; break; }
        }
        if (pnl === null) pnl = ((bars[endIdx].close - t.px) / t.px) * 100 * (dirUp ? 1 : -1);
        const dc = dcAt(bars, t.idx, t.to, 60);
        legs.push({ pnl, q, tier, dc1: dc?.dc1 ?? null, dc2: dc?.dc2 ?? null, half });
      }
    }
  }
  return { legs, qDays };
}

const fmt = (a: Leg[]) => a.length
  ? `${a.length}레그 누적 ${a.reduce((s, l) => s + l.pnl, 0) >= 0 ? "+" : ""}${a.reduce((s, l) => s + l.pnl, 0).toFixed(1)}%p·승률 ${Math.round((100 * a.filter((l) => l.pnl > 0).length) / a.length)}%·평균 ${(a.reduce((s, l) => s + l.pnl, 0) / a.length).toFixed(3)}%`
  : "0레그";

async function run(code: string, name: string, sb: number): Promise<void> {
  const { legs, qDays } = await collect(code, sb);
  console.log(`\n════ ${name} — Q일수 Q1 ${qDays[1]}·Q2 ${qDays[2]}·Q3 ${qDays[3]}·Q4 ${qDays[4]} ════`);
  console.log("(a) 레짐별 피셔 레그 성적:");
  for (const q of [1, 2, 3, 4] as const) {
    const f = legs.filter((l) => l.q === q && l.tier === "F");
    const b = legs.filter((l) => l.q === q && l.tier === "B");
    console.log(`  Q${q}: F ${fmt(f)} | 본 ${fmt(b)}`);
  }
  const grpA = legs.filter((l) => l.q === 1 || l.q === 3); // 전일추세
  const grpB = legs.filter((l) => l.q === 2 || l.q === 4); // 전일무추세
  for (const [lb, g] of [["전일추세(Q1+Q3)", grpA], ["전일무추세(Q2+Q4)", grpB]] as const) {
    const hh = [0, 1].map((h) => g.filter((l) => l.half === h).reduce((s, l) => s + l.pnl, 0).toFixed(1));
    console.log(`  ${lb}: 전체 ${fmt(g)} (전/후 ${hh.join("/")})`);
  }
  console.log("(b) 그룹 조건부 DC 게이트 (확인 시점 60분 창, F+본 합산):");
  const halves = (a: Leg[]) => [0, 1].map((h) => a.filter((l) => l.half === h).reduce((s, l) => s + l.pnl, 0).toFixed(1)).join("/");
  for (const [lb, g] of [["전일추세", grpA], ["전일무추세", grpB]] as const) {
    const known = g.filter((l) => l.dc2 !== null);
    const hiE = known.filter((l) => l.dc2! >= 0.35);
    const loE = known.filter((l) => l.dc2! < 0.35);
    const exh = known.filter((l) => l.dc1! >= 0.6);
    const ok = known.filter((l) => l.dc1! < 0.6);
    console.log(`  ${lb}: DC2≥0.35 ${fmt(hiE)} (전/후 ${halves(hiE)}) | DC2<0.35 ${fmt(loE)} (전/후 ${halves(loE)})`);
    console.log(`  ${lb}: DC1<0.6 ${fmt(ok)} (전/후 ${halves(ok)}) | DC1≥0.6(소진) ${fmt(exh)} (전/후 ${halves(exh)})`);
  }
}

async function main() {
  await run("005930", "삼전", 0.075);
  await run("000660", "하닉", 0.1);
}
main().catch((e) => { console.error(e); process.exit(1); });
