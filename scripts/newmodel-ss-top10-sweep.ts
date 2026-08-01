// 신모델(창판정) 삼전·TOP10 이식 최적화 (사용자 지시 2026-08-01 "승률 70% 이상 조건을 최적화로 찾아봐"):
//   npx tsx scripts/newmodel-ss-top10-sweep.ts
// 하닉 채택 프레임을 종목별 재탐색: 각도 눈금 × 스탑 × 품질 게이트(진행성·피셔F 동의·저변동일) × 청산.
// 합격 기준: 승률 ≥70% & 표본 ≥25(삼전)/≥15(TOP10) — 다중 비교 과최적화 방지로 이웃 조합도 함께 출력.
// 진입 현실성: 게이트 충족이 확인되는 시점(둘 중 늦은 신호)의 종가로 진입 — 선견 없음.
// 삼전 = 프리장 연속창·F 0.05·4봉·완충3(확인 09:00~), TOP10 = 09시창·F 0.05·2봉 (라이브 상수).

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange, isHighVolDay } from "../lib/predict/indicators";
import { fetchDailyPredict } from "../lib/predict/data";
import { candleJudgeStream } from "../lib/predict/candleWindow";
import type { MinuteBar } from "../lib/predict/types";

const CACHE_DIR = resolve(process.cwd(), ".predict-cache");
const rc = (f: string): MinuteBar[] | null => {
  const p = resolve(CACHE_DIR, f);
  if (!existsSync(p)) return null;
  try { const b = JSON.parse(readFileSync(p, "utf8")) as MinuteBar[]; return b?.length ? b : null; } catch { return null; }
};
const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);

function unitOf(bars: MinuteBar[], r10: number, scale: number): number[] {
  const rng = bars.map((b) => b.high - b.low);
  return bars.map((_, t) => {
    const lo = Math.max(0, t - 30);
    const w = rng.slice(lo, Math.max(lo + 1, t));
    const u = w.length ? w.reduce((a, b) => a + b, 0) / w.length : r10 / 100;
    return Math.max(u * scale, 1e-9);
  });
}

function fisherFirst(bars: MinuteBar[], r10: number, off: number, conf: number, sb: number, em: number, gate9: boolean): { t: number; i: number; dir: 1 | -1 } | null {
  if (bars.length < 16) return null;
  const orH = Math.max(...bars.slice(0, 15).map((b) => b.high));
  const orL = Math.min(...bars.slice(0, 15).map((b) => b.low));
  let up = 0, dn = 0;
  const emUntil = tMin("10:30"), from9 = tMin("09:00");
  for (let i = 15; i < bars.length; i++) {
    const b = bars[i];
    const t = tMin(b.time);
    const e = em > 1 && t < emUntil ? em : 1;
    const aUp = orH + off * r10 * e, aDn = orL - off * r10 * e, sbW = sb * r10 * e;
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (sbW > 0) {
      if (b.close > aUp + sbW) up = Math.max(up, conf);
      if (b.close < aDn - sbW) dn = Math.max(dn, conf);
    }
    if (gate9 && t < from9) continue;
    if (up >= conf) return { t, i, dir: 1 };
    if (dn >= conf) return { t, i, dir: -1 };
  }
  return null;
}

type Day = { date: string; bars: MinuteBar[]; r10: number; close: number; hv: boolean; f: ReturnType<typeof fisherFirst>; trsBy: Map<number, ReturnType<typeof candleJudgeStream>> };

async function run(nm: string, code: string, preCode: string | null, fCfg: { off: number; conf: number; sb: number; em: number; gate9: boolean }, stops: number[], minN: number) {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict(code, 500)).filter((b) => b.date < today);
  const SCALES = [0.3, 0.4, 0.5, 0.7];
  const days: Day[] = [];
  for (let i = 130; i < daily.length; i++) {
    const reg = rc(`${code}-${daily[i].date}.json`);
    const pre = preCode ? rc(`${preCode}-${daily[i].date}.json`) : null;
    const hist = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (!reg || reg.length < 240 || r10 === null) continue;
    const bars = [...(pre ?? []), ...reg];
    const trsBy = new Map<number, ReturnType<typeof candleJudgeStream>>();
    for (const s of SCALES) trsBy.set(s, candleJudgeStream(bars, unitOf(bars, r10, s)));
    days.push({
      date: daily[i].date, bars, r10, close: daily[i].close, hv: isHighVolDay(hist),
      f: fisherFirst(bars, r10, fCfg.off, fCfg.conf, fCfg.sb, fCfg.em, fCfg.gate9),
      trsBy,
    });
  }
  console.log(`\n===== ${nm} (${days.length}일) — 합격: 승률 ≥70% & n ≥ ${minN} =====`);
  type Res = { label: string; n: number; win: number; cut: number; sum: number };
  const all: Res[] = [];
  for (const scale of SCALES) {
    for (const stop of stops) {
      for (const prog of [0, 0.1]) {
        for (const agree of [false, true]) {
          for (const vol of ["전체", "저변동만"] as const) {
            for (const exit of ["종가", "전환"] as const) {
              const legs: { pnl: number; cut: boolean }[] = [];
              for (const d of days) {
                if (vol === "저변동만" && d.hv) continue;
                const trs = d.trsBy.get(scale)!;
                if (!trs.length) continue;
                const cw0 = trs[0];
                const dir = (cw0.to === "up" ? 1 : -1) as 1 | -1;
                if (agree && (!d.f || d.f.dir !== dir)) continue;
                // 진입 시점 = 게이트 충족 확인 시점 (선견 방지)
                let entryI = cw0.i;
                if (agree && d.f && d.f.i > entryI) entryI = d.f.i;
                if (prog > 0) {
                  const pI = cw0.i + 5;
                  if (pI >= d.bars.length) continue;
                  if ((d.bars[pI].close - cw0.px) * dir < prog * d.r10) continue;
                  entryI = Math.max(entryI, pI);
                }
                const px = d.bars[entryI].close;
                const flip = trs.find((t) => t.i > cw0.i && t.to !== cw0.to);
                if (flip && flip.i <= entryI) continue; // 진입 확정 전에 이미 전환 — 무효
                const endI = exit === "전환" && flip ? flip.i : undefined;
                const endPx = exit === "전환" && flip ? flip.px : undefined;
                const s = stop / 100;
                let pnl: number | null = null, cut = false;
                const lim = endI ?? d.bars.length;
                for (let k = entryI + 1; k < lim; k++) {
                  const b = d.bars[k];
                  if (dir === 1 ? b.low <= px * (1 - s) : b.high >= px * (1 + s)) { pnl = -stop; cut = true; break; }
                }
                if (pnl === null) pnl = (((endI !== undefined ? endPx ?? d.close : d.close) - px) / px) * 100 * dir;
                legs.push({ pnl, cut });
              }
              if (!legs.length) continue;
              const n = legs.length;
              const win = Math.round((100 * legs.filter((l) => l.pnl > 0).length) / n);
              const cut = Math.round((100 * legs.filter((l) => l.cut).length) / n);
              const sum = legs.reduce((a, l) => a + l.pnl, 0);
              all.push({ label: `눈금${scale} 스탑${stop} ${prog > 0 ? "진행성 " : ""}${agree ? "F동의 " : ""}${vol} ${exit}`, n, win, cut, sum });
            }
          }
        }
      }
    }
  }
  const pass = all.filter((r) => r.win >= 70 && r.n >= minN).sort((a, b) => b.sum - a.sum);
  if (!pass.length) console.log("합격 조합 없음");
  for (const r of pass.slice(0, 10)) console.log(`✓ ${r.label}: ${r.n}건 승률 ${r.win}%·컷률 ${r.cut}%·합 ${r.sum >= 0 ? "+" : ""}${r.sum.toFixed(1)}%p (건당 ${(r.sum / r.n).toFixed(2)})`);
  console.log("--- 참고: 합계 상위 5 (승률 무관) ---");
  for (const r of [...all].sort((a, b) => b.sum - a.sum).slice(0, 5)) console.log(`  ${r.label}: ${r.n}건 승률 ${r.win}%·컷률 ${r.cut}%·합 ${r.sum >= 0 ? "+" : ""}${r.sum.toFixed(1)}%p`);
  console.log("--- 참고: 승률 상위 5 (표본 10건 이상) ---");
  for (const r of [...all].filter((x) => x.n >= 10).sort((a, b) => b.win - a.win).slice(0, 5)) console.log(`  ${r.label}: ${r.n}건 승률 ${r.win}%·컷률 ${r.cut}%·합 ${r.sum >= 0 ? "+" : ""}${r.sum.toFixed(1)}%p`);
}

async function main() {
  await run("삼전", "005930", "005930NX", { off: 0.05, conf: 4, sb: 0.075, em: 3, gate9: true }, [1.0, 1.5, 2.0], 25);
  await run("TOP10", "396500", null, { off: 0.05, conf: 2, sb: 0.075, em: 1, gate9: false }, [1.0, 1.5], 15);
}
main().catch((e) => { console.error(e); process.exit(1); });
