// SOXX 되돌림 이탈·왕복 모델 실측 (사용자 지시 2026-08-01 "하닉은 안 될 것 같고 SOXX에 적용해봐"):
//   npx tsx scripts/soxx-pullback-sweep.ts
// 대상: 미장 SOXX 피셔F 첫 판정 레그 (야후 5분봉 ~37일 소표본, 라이브 상수 0.05·1봉·강돌파 0.1·전환 1봉).
// 스탑 -1.5%(미장 기준). 청산 비교: 종가보유 / 트레일 T×10일폭 / 무장 트레일 / 왕복(이탈 T→저점 R 회복 복귀).
// 하닉 실측(pullback-exit-sweep.ts)에서는 전 변형 열위·왕복 최적점만 소폭 상회(비용 미반영) — 미장은 컷
// 중앙 60~80분·추세 지속성이 달라 별도 검증 (사용자 가설: 미장이 되돌림 모델에 더 맞을 것).

import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { avgRange } from "../lib/predict/indicators";
import { fetchJudge5m, fetchJudgeDaily } from "../lib/signal/us/predictStream";

const tMin = (s: string) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
type Bar = { time: string; etMin: number; open: number; high: number; low: number; close: number };

// 미장 피셔F 첫 판정 (prog5-all-sweep.ts SOXX 구간과 동일 상수: off 0.05·conf 1·sb 0.1·rev 1)
function fisherFirst(bars: Bar[], r10: number): { i: number; dir: 1 | -1; px: number } | null {
  if (bars.length < 16) return null;
  const orH = Math.max(...bars.slice(0, 15).map((b) => b.high));
  const orL = Math.min(...bars.slice(0, 15).map((b) => b.low));
  let up = 0, dn = 0;
  for (let i = 15; i < bars.length; i++) {
    const b = bars[i];
    const aUp = orH + 0.05 * r10, aDn = orL - 0.05 * r10, sbW = 0.1 * r10;
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (b.close > aUp + sbW) up = Math.max(up, 1);
    if (b.close < aDn - sbW) dn = Math.max(dn, 1);
    if (up >= 1) return { i, dir: 1, px: b.close };
    if (dn >= 1) return { i, dir: -1, px: b.close };
  }
  return null;
}

type Leg = { bars: Bar[]; i0: number; dir: 1 | -1; px: number; r10: number; close: number };
const STOP = 1.5;

function exitPnl(L: Leg, opt: { trailR?: number; armPct?: number }): { pnl: number; kind: string } {
  const s = STOP / 100;
  let ext = L.px;
  let armed = opt.armPct === undefined;
  const trailW = (opt.trailR ?? 0) * L.r10;
  for (let k = L.i0 + 1; k < L.bars.length; k++) {
    const b = L.bars[k];
    if (L.dir === 1 ? b.low <= L.px * (1 - s) : b.high >= L.px * (1 + s)) return { pnl: -STOP, kind: "스탑" };
    ext = L.dir === 1 ? Math.max(ext, b.close) : Math.min(ext, b.close);
    if (!armed && opt.armPct !== undefined && ((ext - L.px) / L.px) * 100 * L.dir >= opt.armPct) armed = true;
    if (trailW > 0 && armed) {
      const pullback = L.dir === 1 ? ext - b.close : b.close - ext;
      if (pullback >= trailW) return { pnl: ((b.close - L.px) / L.px) * 100 * L.dir, kind: "트레일" };
    }
  }
  return { pnl: ((L.close - L.px) / L.px) * 100 * L.dir, kind: "종가" };
}

function roundTrip(L: Leg, T: number, R: number, armPct?: number): { pnl: number; trips: number } {
  const s = STOP / 100;
  let pnl = 0, trips = 0;
  let inPos = true, tPx = L.px, ext = L.px, pullLow = 0;
  let armed = armPct === undefined;
  for (let k = L.i0 + 1; k < L.bars.length; k++) {
    const b = L.bars[k];
    if (inPos) {
      if (L.dir === 1 ? b.low <= tPx * (1 - s) : b.high >= tPx * (1 + s)) return { pnl: pnl - STOP, trips };
      ext = L.dir === 1 ? Math.max(ext, b.close) : Math.min(ext, b.close);
      if (!armed && armPct !== undefined && ((ext - L.px) / L.px) * 100 * L.dir >= armPct) armed = true;
      const pullback = L.dir === 1 ? ext - b.close : b.close - ext;
      if (armed && pullback >= T * L.r10) {
        pnl += ((b.close - tPx) / tPx) * 100 * L.dir;
        inPos = false; pullLow = b.close;
      }
    } else {
      pullLow = L.dir === 1 ? Math.min(pullLow, b.close) : Math.max(pullLow, b.close);
      const recover = L.dir === 1 ? b.close - pullLow : pullLow - b.close;
      if (recover >= R * L.r10) { inPos = true; trips++; tPx = b.close; ext = b.close; }
    }
  }
  if (inPos) pnl += ((L.close - tPx) / tPx) * 100 * L.dir;
  return { pnl, trips };
}

async function main() {
  const byDay = await fetchJudge5m(55);
  const daily = await fetchJudgeDaily(140);
  const legs: Leg[] = [];
  for (const d of [...byDay.keys()].sort()) {
    const all = byDay.get(d) ?? [];
    const w = all.filter((b) => b.etMin >= 7 * 60 && b.etMin < 16 * 60) as unknown as Bar[];
    const reg = all.filter((b) => b.etMin >= 9 * 60 + 30 && b.etMin < 16 * 60);
    const idx = daily.findIndex((x) => x.date === d);
    if (w.length < 60 || idx < 15) continue;
    const r10 = avgRange(daily.slice(Math.max(0, idx - 120), idx), 10);
    if (r10 === null) continue;
    const close = reg.length ? reg[reg.length - 1].close : w[w.length - 1].close;
    const f = fisherFirst(w, r10);
    if (!f) continue;
    legs.push({ bars: w, i0: f.i, dir: f.dir, px: f.px, r10, close });
  }
  const rep = (label: string, opt: Parameters<typeof exitPnl>[1]) => {
    const rs = legs.map((L) => exitPnl(L, opt));
    const n = rs.length, sum = rs.reduce((a, r) => a + r.pnl, 0);
    const win = Math.round((100 * rs.filter((r) => r.pnl > 0).length) / n);
    console.log(`${label} 합 ${sum >= 0 ? "+" : ""}${sum.toFixed(1).padStart(6)}%p · 평균 ${(sum / n).toFixed(2)}%·승률 ${win}%·스탑 ${rs.filter((r) => r.kind === "스탑").length}·트레일 ${rs.filter((r) => r.kind === "트레일").length}`);
  };
  console.log(`SOXX F 첫 판정 레그 ${legs.length}건 (~37일 소표본 — 방향 참고용)\n`);
  rep("A 종가보유            ", {});
  for (const t of [0.15, 0.2, 0.3, 0.4]) rep(`트레일 ${t.toFixed(2)}×r10 상시   `, { trailR: t });
  for (const p of [0.7, 1.0]) for (const t of [0.15, 0.2, 0.3]) rep(`무장+${p.toFixed(1)}% 트레일 ${t.toFixed(2)} `, { trailR: t, armPct: p });
  console.log("\n[왕복 — 이탈 T → 저점 R 회복 복귀]");
  for (const arm of [undefined, 0.7]) {
    for (const T of [0.15, 0.2, 0.3]) {
      for (const R of [0.07, 0.1, 0.15]) {
        const rs = legs.map((L) => roundTrip(L, T, R, arm));
        const sum = rs.reduce((a, r) => a + r.pnl, 0);
        const trips = rs.reduce((a, r) => a + r.trips, 0);
        const win = Math.round((100 * rs.filter((r) => r.pnl > 0).length) / rs.length);
        console.log(`${arm !== undefined ? `무장+${arm.toFixed(1)}% ` : "상시     "} T=${T.toFixed(2)} R=${R.toFixed(2)}: 합 ${sum >= 0 ? "+" : ""}${sum.toFixed(1).padStart(6)}%p · 승률 ${win}%·복귀 ${trips}회`);
      }
    }
  }
  console.log("\n주: 5분봉·스탑 -1.5%·r10 = 10일 평균 일중폭. 소표본 — 방향 일관성 위주로 판단.");
}
main().catch((e) => { console.error(e); process.exit(1); });
