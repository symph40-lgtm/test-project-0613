// 애프터장 3단계(F/M/본) 사다리 실측 (사용자 지시 2026-07-26 — "백테스트 후보로 올려 검증해서
// 괜찮으면 적용"). npx tsx scripts/after-ladder-sweep.ts   (.predict-cache 전용 — 무통신)
//
// 현행 애프터 판정 = 피셔 단독 (오프셋 = 세션 시가 0.4%·OR 15:30~15:45·확인 8봉·반전 5봉).
// 후보: 정규장 3단계의 비율 유추 — F = 본의 1/3 문턱·확인 절반(0.13%·4봉), M = 중간(0.27%·8봉).
// 격자는 유추값 주변 최소로 (선택 과적합 방지), 채택 기준은 프로젝트 공통:
//   하닉·삼전 모두 + 전·후반 모두에서 (a) F 선행 리드가 실재하고 (b) F 조기 진입 경제성이
//   본 단독 대비 악화 없지 않을 것, (c) M 동반/미동반이 F 품질을 가를 것 (정규장 97/50 구조 재현).
// 경제성: 전이 레그별 진입(전이봉 종가)→다음 전이(또는 세션 마지막봉) 청산, 스탑 본주 -1.5% 관통.

import { existsSync, readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import type { MinuteBar } from "../lib/predict/types";

const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const readCache = (file: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, file);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
const STOP = 1.5;

type St = "none" | "up" | "down";
type Trans = { time: string; to: St; px: number; idx: number };
function stream(bars: MinuteBar[], orN: number, offsetWon: number, confirm: number, reversal: number): Trans[] {
  if (bars.length < orN + confirm) return [];
  const or = bars.slice(0, orN);
  const aUp = Math.max(...or.map((b) => b.high)) + offsetWon;
  const aDn = Math.min(...or.map((b) => b.low)) - offsetWon;
  const out: Trans[] = [];
  let st: St = "none", up = 0, dn = 0;
  for (let i = orN; i < bars.length; i++) {
    const b = bars[i];
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (st === "none") {
      if (up >= confirm) { st = "up"; out.push({ time: b.time, to: st, px: b.close, idx: i }); }
      else if (dn >= confirm) { st = "down"; out.push({ time: b.time, to: st, px: b.close, idx: i }); }
    } else if (st === "up" && dn >= reversal) { st = "down"; out.push({ time: b.time, to: st, px: b.close, idx: i }); }
    else if (st === "down" && up >= reversal) { st = "up"; out.push({ time: b.time, to: st, px: b.close, idx: i }); }
  }
  return out;
}

// 레그 경제성 — 각 전이에서 진입, 다음 전이(또는 마지막봉)에서 청산, 레그 내 스탑 -1.5% 관통
function legsPnl(bars: MinuteBar[], ts: Trans[]): { pnl: number; legs: number; stops: number } {
  let pnl = 0, stops = 0;
  for (let k = 0; k < ts.length; k++) {
    const t = ts[k];
    const endIdx = k + 1 < ts.length ? ts[k + 1].idx : bars.length - 1;
    const exitPx = bars[endIdx].close;
    const dirUp = t.to === "up";
    let cut = false;
    for (let i = t.idx + 1; i <= endIdx; i++) {
      const adverse = dirUp ? ((bars[i].low - t.px) / t.px) * 100 : ((t.px - bars[i].high) / t.px) * 100;
      if (adverse <= -STOP) { cut = true; break; }
    }
    pnl += cut ? -STOP : ((exitPx - t.px) / t.px) * 100 * (dirUp ? 1 : -1);
    if (cut) stops++;
  }
  return { pnl, legs: ts.length, stops };
}

type Day = { date: string; bars: MinuteBar[]; half: 0 | 1 };
function loadDays(code: string, pattern: (d: string) => string): Day[] {
  const rx = code === "000660" ? /^000660NXA-(\d{4}-\d{2}-\d{2})\.json$/ : /^005930-ah-(\d{4}-\d{2}-\d{2})\.json$/;
  const dates = readdirSync(CACHE_DIR).map((f) => f.match(rx)?.[1]).filter(Boolean).sort() as string[];
  const out: Day[] = [];
  for (const d of dates) {
    const bars = readCache(pattern(d));
    if (!bars || bars.length < 60) continue;
    out.push({ date: d, bars, half: 0 });
  }
  out.forEach((x, i) => { x.half = i < out.length / 2 ? 0 : 1; });
  return out;
}

type Variant = { name: string; offPct: number; confirm: number };
const VARIANTS: Variant[] = [
  { name: "F 0.10·4", offPct: 0.10, confirm: 4 },
  { name: "F 0.13·4", offPct: 0.13, confirm: 4 },
  { name: "F 0.15·4", offPct: 0.15, confirm: 4 },
  { name: "F 0.20·4", offPct: 0.20, confirm: 4 },
  { name: "M 0.25·8", offPct: 0.25, confirm: 8 },
  { name: "M 0.30·8", offPct: 0.30, confirm: 8 },
  { name: "본 0.40·8", offPct: 0.40, confirm: 8 },
];

function run(name: string, days: Day[]): void {
  console.log(`\n════ ${name} — ${days.length}일 ════`);
  console.log("변형별 단독 성적 (레그 경제성·첫방향 부호적중·판정일수):");
  const cache = new Map<string, Map<string, Trans[]>>(); // variant → date → transitions
  for (const v of VARIANTS) {
    const m = new Map<string, Trans[]>();
    let pnl = 0, legs = 0, stops = 0, dirDays = 0, sign = 0;
    const h = [0, 0], hd = [0, 0];
    for (const d of days) {
      const offWon = (v.offPct / 100) * d.bars[0].open;
      const ts = stream(d.bars, 15, offWon, v.confirm, 5);
      m.set(d.date, ts);
      const e = legsPnl(d.bars, ts);
      pnl += e.pnl; legs += e.legs; stops += e.stops;
      h[d.half] += e.pnl;
      if (ts.length) {
        dirDays++;
        const first = ts[0];
        const close = d.bars[d.bars.length - 1].close;
        const rem = ((close - first.px) / first.px) * 100 * (first.to === "up" ? 1 : -1);
        if (rem > 0) sign++;
        hd[d.half]++;
      }
    }
    cache.set(v.name, m);
    console.log(`  ${v.name}: 판정 ${dirDays}일·레그 ${legs}(스탑 ${stops}) · 누적 ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%p (전반 ${h[0].toFixed(1)}/후반 ${h[1].toFixed(1)}) · 첫진입 잔여+ ${dirDays ? Math.round((100 * sign) / dirDays) : 0}%`);
  }

  // F 선행 리드 + M 게이트 (유추값 F 0.13·4 / M 0.27≈0.25·8 vs 본 0.40·8)
  for (const fName of ["F 0.10·4", "F 0.13·4", "F 0.15·4", "F 0.20·4"]) {
    const fM = cache.get(fName)!, mM = cache.get("M 0.25·8")!, bM = cache.get("본 0.40·8")!;
    let lead: number[] = [], mSameHit = 0, mSameN = 0, mNoHit = 0, mNoN = 0;
    let mSamePnl = 0, mNoPnl = 0;
    for (const d of days) {
      const f = fM.get(d.date) ?? [], mm = mM.get(d.date) ?? [], b = bM.get(d.date) ?? [];
      if (!f.length) continue;
      const first = f[0];
      const bSame = b.find((t) => t.to === first.to);
      if (bSame) lead.push(tMin(bSame.time) - tMin(first.time));
      // M 게이트: F 첫확인과 같은 방향을 M이 (그날 안에) 확인하는가 — F 첫레그 품질 분리
      const mSame = mm.find((t) => t.to === first.to);
      const close = d.bars[d.bars.length - 1].close;
      const rem = ((close - first.px) / first.px) * 100 * (first.to === "up" ? 1 : -1);
      const capped = Math.max(rem, -STOP);
      if (mSame) { mSameN++; mSamePnl += capped; if (rem > 0) mSameHit++; }
      else { mNoN++; mNoPnl += capped; if (rem > 0) mNoHit++; }
    }
    lead = lead.sort((a, b) => a - b);
    console.log(`  ${fName} 기준 — 본 확인 선행 리드: 중앙 ${lead[Math.floor(lead.length / 2)] ?? "-"}분 (본 동방향 확인 ${lead.length}일)`);
    console.log(`    M(0.25) 동반 ${mSameN}일: 잔여+ ${mSameN ? Math.round((100 * mSameHit) / mSameN) : 0}%·스탑컷 손익 ${mSamePnl >= 0 ? "+" : ""}${mSamePnl.toFixed(1)}%p | M 미동반 ${mNoN}일: 잔여+ ${mNoN ? Math.round((100 * mNoHit) / mNoN) : 0}%·${mNoPnl >= 0 ? "+" : ""}${mNoPnl.toFixed(1)}%p`);
  }
}

run("하닉 (000660, NXA 캐시)", loadDays("000660", (d) => `000660NXA-${d}.json`));
run("삼전 (005930, ah 캐시)", loadDays("005930", (d) => `005930-ah-${d}.json`));
