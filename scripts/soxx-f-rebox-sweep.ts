// SOXX F 0930 재박스 스윕 — 프리장(07시) OR을 정규장에 그대로 쓰는 문제 검증 (사용자 지적 2026-08-04 새벽
// "프리장과 정규장 진폭이 너무 차이 — 프리장 OR을 정규장에 그대로 쓰는 건 아닌 것 같다"):
//   npx tsx scripts/soxx-f-rebox-sweep.ts
// 하닉·삼전에서 채택된 0930 rebox(상태 승계·박스만 재앵커)의 SOXX판. 기존 실측과의 관계:
//   - "심판 정규장창 -2.5 붕괴"(3276ae7)는 07시 창을 버리고 09:30 새 OR로 시작한 것 — 프리장 확인 자체를
//     잃는 변형. rebox는 프리장 확인(중앙 07:49~08:29)을 그대로 두고 09:45부터 앵커만 교체 — 미측정이었음.
//   - 신모델은 F의 '첫 확인'만 심판으로 쓰므로 rebox 영향 = 첫 확인이 박스 완성 후인 날 한정.
// 채점: 통합 사양(수정안 — 창1선행 이견 보유·비이견 1박 + F선행 E1) 245일, lib 함수 재사용.

import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import YahooFinance from "yahoo-finance2";
import { runFisher } from "../lib/predict/models/fisher";
import { scoreSoxxDay, soxxUnitArr, SOXX_ET_OPEN, SOXX_ET_PRE, SOXX_ET_CLOSE, type SoxxBar, type SoxxJ } from "../lib/signal/us/soxxV2";
import type { MinuteBar, PredictDailyBar } from "../lib/predict/types";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const CACHE = resolve(process.cwd(), ".predict-cache");
const s1 = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
const fmtT = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function to5m(bars: SoxxBar[]): SoxxBar[] {
  const map = new Map<number, SoxxBar>();
  for (const b of bars) {
    const k = Math.floor(b.etMin / 5) * 5;
    const cur = map.get(k);
    if (!cur) map.set(k, { ...b, etMin: k, time: fmtT(k) });
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; }
  }
  return [...map.values()].sort((a, b) => a.etMin - b.etMin);
}

function judgeWith(date: string, raw: SoxxBar[], hist: PredictDailyBar[], r10: number, rebox: { reboxHHMM: string; reboxMinutes: number } | null): { c1: SoxxJ | null; fJ: SoxxJ | null } {
  const unit = soxxUnitArr(raw, r10);
  let c1: SoxxJ | null = null;
  const bmid = (b: SoxxBar) => (b.open + b.close) / 2;
  for (let t = 5; t < raw.length && !c1; t++) {
    if (raw[t].etMin < SOXX_ET_OPEN) continue;
    for (const dir of [1, -1] as const) {
      if ((bmid(raw[t]) - bmid(raw[t - 5])) * dir >= unit[t - 5] * 5) { c1 = { i: t, t: raw[t].etMin, dir, px: raw[t].close }; break; }
    }
  }
  let fJ: SoxxJ | null = null;
  const b5 = to5m(raw);
  if (b5.length >= 5) {
    const morning: MinuteBar[] = b5.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    const fOut = runFisher({ date, dailyHistory: hist, openPx: b5[0].open, morning, prevDayMinutes: null },
      { orMinutes: 3, offsetRangeRatio: 0.05, confirmMinutes: 1, reversalMinutes: 1, strongBreakRatio: 0.1, ...(rebox ?? {}) });
    const trs = fOut.transitions ?? [];
    if (trs.length) {
      const k5 = b5.findIndex((b) => b.time === trs[0].time);
      if (k5 >= 0) {
        const endMin = b5[k5].etMin + 4;
        let i1 = raw.findIndex((b) => b.etMin >= endMin);
        if (i1 < 0) i1 = raw.length - 1;
        fJ = { i: i1, t: raw[i1].etMin, dir: (trs[0].to === "up" ? 1 : -1) as 1 | -1, px: trs[0].px };
      }
    }
  }
  return { c1, fJ };
}

async function main() {
  const rD = await yf.chart("SOXX", { period1: new Date(Date.now() - 3 * 365 * 86400e3), interval: "1d" });
  const daily: PredictDailyBar[] = (rD.quotes ?? [])
    .filter((q): q is typeof q & { open: number; high: number; low: number; close: number } => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({ date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10), open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 }));
  const dIdx = daily.map((b) => b.date);
  const dBy = new Map(daily.map((b) => [b.date, b]));
  const files = readdirSync(CACHE).filter((f) => /^SOXXM-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();

  const variants: { label: string; rebox: { reboxHHMM: string; reboxMinutes: number } | null }[] = [
    { label: "현행 (07시 OR 유지)     ", rebox: null },
    { label: "rebox 09:30~45 (하닉식) ", rebox: { reboxHHMM: "09:30", reboxMinutes: 15 } },
    { label: "rebox 10:00~15          ", rebox: { reboxHHMM: "10:00", reboxMinutes: 15 } },
  ];
  const tot = variants.map(() => ({ p: 0, n: 0, worst: 0, cut: 0, diff: 0, fLate: 0 }));
  for (const f of files) {
    const date = f.slice(6, 16);
    const rawAll = JSON.parse(readFileSync(resolve(CACHE, f), "utf8")) as SoxxBar[];
    const raw = rawAll.filter((b) => b.etMin >= SOXX_ET_PRE && b.etMin < SOXX_ET_CLOSE).sort((a, b) => a.etMin - b.etMin);
    const reg = raw.filter((b) => b.etMin >= SOXX_ET_OPEN);
    const hist = daily.filter((x) => x.date < date).slice(-60);
    if (reg.length < 250 || hist.length < 11) continue;
    const r10 = hist.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
    const next = dIdx.find((x) => x > date);
    const nextOpen = next ? dBy.get(next)!.open : null;
    const close = reg[reg.length - 1].close;
    const base = judgeWith(date, raw, hist, r10, null);
    for (let v = 0; v < variants.length; v++) {
      const { c1, fJ } = v === 0 ? base : judgeWith(date, raw, hist, r10, variants[v].rebox);
      const sc = scoreSoxxDay(raw, c1, fJ, close, nextOpen);
      tot[v].p += sc.p; tot[v].n++;
      tot[v].worst = Math.min(tot[v].worst, sc.p);
      if (sc.cut) tot[v].cut++;
      if (v > 0) {
        const b0 = base.fJ ? `${base.fJ.t}:${base.fJ.dir}` : "무";
        const b1 = fJ ? `${fJ.t}:${fJ.dir}` : "무";
        if (b0 !== b1) tot[v].diff++;
      }
      if (v === 0 && fJ && fJ.t >= 585) tot[0].fLate++; // 첫 확인이 09:45 이후 — rebox 영향권
    }
  }
  console.log(`════ SOXX F 재박스 스윕 — 통합 사양(수정안) ${tot[0].n}일 ════`);
  console.log(`F 첫 확인이 09:45 이후(재박스 영향권)인 날: ${tot[0].fLate}일`);
  for (let v = 0; v < variants.length; v++) {
    console.log(`${variants[v].label}: ${s1(tot[v].p)}%p · 최악 ${tot[v].worst.toFixed(2)}% · 컷 ${tot[v].cut}일${v > 0 ? ` · F 판정 변화 ${tot[v].diff}일` : ""}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
