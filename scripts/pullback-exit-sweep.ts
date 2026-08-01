// 창판정 레그 되돌림 조기 이탈 실측 (사용자 구상 2026-08-01 "되돌림할 때 빨리 빠져나오는 모델"):
//   npx tsx scripts/pullback-exit-sweep.ts
// 하닉 227일, 창판정 일 최초 판정 레그(130건) 기준. 청산 규칙 비교:
//   기준 A: 종가보유 (스탑 -2.5%만) — 현행 사다리의 기본
//   기준 B: 전환청산 (반대 풀판정) — 현행의 유일한 조기 이탈
//   트레일 T: 진입 후 극값(종가) 대비 T×10일폭 되돌림 봉에서 청산 (상시 활성)
//   무장 트레일 P/T: 미실현 이익(극값 기준)이 P% 이상 됐을 때만 트레일 활성 — "벌었으면 지킨다"
// 스탑 -2.5%는 전 규칙 공통(트레일과 먼저 오는 쪽). 되돌림 반납 방지 vs 추세 조기 하차 비용을 비교.

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

type Leg = { bars: MinuteBar[]; i0: number; dir: 1 | -1; px: number; r10: number; close: number; flipI?: number; flipPx?: number };

// 청산 시뮬: 스탑 -2.5% / (활성 시) 트레일 / (옵션) 전환 인덱스 중 먼저 오는 것, 없으면 종가
function exitPnl(L: Leg, opt: { trailR?: number; armPct?: number; useFlip?: boolean }): { pnl: number; kind: string } {
  const s = 2.5 / 100;
  let ext = L.px;
  let armed = opt.armPct === undefined; // armPct 없으면 즉시 활성
  const trailW = (opt.trailR ?? 0) * L.r10;
  const flipI = opt.useFlip ? L.flipI : undefined;
  for (let k = L.i0 + 1; k < L.bars.length; k++) {
    const b = L.bars[k];
    if (flipI !== undefined && k >= flipI) return { pnl: ((L.flipPx! - L.px) / L.px) * 100 * L.dir, kind: "전환" };
    if (L.dir === 1 ? b.low <= L.px * (1 - s) : b.high >= L.px * (1 + s)) return { pnl: -2.5, kind: "스탑" };
    ext = L.dir === 1 ? Math.max(ext, b.close) : Math.min(ext, b.close);
    if (!armed && opt.armPct !== undefined && ((ext - L.px) / L.px) * 100 * L.dir >= opt.armPct) armed = true;
    if (trailW > 0 && armed) {
      const pullback = L.dir === 1 ? ext - b.close : b.close - ext;
      if (pullback >= trailW) return { pnl: ((b.close - L.px) / L.px) * 100 * L.dir, kind: "트레일" };
    }
  }
  return { pnl: ((L.close - L.px) / L.px) * 100 * L.dir, kind: "종가" };
}

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict("000660", 500)).filter((b) => b.date < today);
  const legs: Leg[] = [];
  for (let i = 130; i < daily.length; i++) {
    const reg = rc(`000660-${daily[i].date}.json`);
    const pre = rc(`000660NX-${daily[i].date}.json`);
    const hist = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (!reg || reg.length < 240 || r10 === null) continue;
    const bars = [...(pre ?? []), ...reg];
    const trs = candleJudgeStream(bars, unitArr(bars, r10));
    if (!trs.length) continue;
    const e = trs[0];
    const flip = trs.find((t) => t.i > e.i && t.to !== e.to);
    legs.push({
      bars, i0: e.i, dir: e.to === "up" ? 1 : -1, px: e.px, r10, close: daily[i].close,
      flipI: flip?.i, flipPx: flip?.px,
    });
  }
  const report = (label: string, opt: Parameters<typeof exitPnl>[1]) => {
    const rs = legs.map((L) => exitPnl(L, opt));
    const n = rs.length, sum = rs.reduce((a, r) => a + r.pnl, 0);
    const win = Math.round((100 * rs.filter((r) => r.pnl > 0).length) / n);
    const cut = rs.filter((r) => r.kind === "스탑").length;
    const tra = rs.filter((r) => r.kind === "트레일").length;
    console.log(`${label} 합 ${sum >= 0 ? "+" : ""}${sum.toFixed(1).padStart(6)}%p · 평균 ${(sum / n).toFixed(2)}%·승률 ${win}%·스탑 ${cut}회·트레일청산 ${tra}회`);
  };
  console.log(`창판정 첫 레그 ${legs.length}건 (하닉 227일)\n`);
  report("A 종가보유            ", {});
  report("B 전환청산            ", { useFlip: true });
  for (const t of [0.2, 0.3, 0.4, 0.5]) report(`트레일 ${t.toFixed(1)}×r10 상시    `, { trailR: t });
  console.log("");
  for (const p of [1.0, 1.5, 2.0]) {
    for (const t of [0.2, 0.3, 0.4]) report(`무장 +${p.toFixed(1)}% 후 트레일 ${t.toFixed(1)}`, { trailR: t, armPct: p });
  }
  console.log("\n주: 트레일 = 진입 후 극값(종가) 대비 T×10일폭 되돌림 봉 종가 청산. 무장형은 미실현 +P% 도달 후에만 활성.");

  // 왕복 모델 (사용자 제안 2차: "빠져나왔다가 원래 방향 재개면 약한 신호로 복귀 — 추세 관성"):
  //   되돌림 T×r10 → 이탈(실현) → 이탈 후 저점 대비 R×r10 회복 → 같은 방향 복귀(반복 허용).
  //   보유 중 스탑 -2.5%(트랜치 진입가 앵커)면 레그 종료. 이탈 상태로 마감이면 그대로 종료.
  const roundTrip = (L: Leg, T: number, R: number, armPct?: number): { pnl: number; trips: number } => {
    const s = 2.5 / 100;
    let pnl = 0, trips = 0;
    let inPos = true, tPx = L.px, ext = L.px, pullLow = 0;
    let armed = armPct === undefined;
    for (let k = L.i0 + 1; k < L.bars.length; k++) {
      const b = L.bars[k];
      if (inPos) {
        if (L.dir === 1 ? b.low <= tPx * (1 - s) : b.high >= tPx * (1 + s)) return { pnl: pnl - 2.5, trips };
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
        if (recover >= R * L.r10) {
          inPos = true; trips++; tPx = b.close; ext = b.close;
        }
      }
    }
    if (inPos) pnl += ((L.close - tPx) / tPx) * 100 * L.dir;
    return { pnl, trips };
  };
  console.log("\n[왕복 모델 — 이탈 T → 저점 대비 R 회복 시 복귀 (기준 A 종가보유 +83.4%p)]");
  for (const arm of [undefined, 1.0]) {
    for (const T of [0.15, 0.2, 0.3]) {
      for (const R of [0.1, 0.15, 0.2]) {
        const rs = legs.map((L) => roundTrip(L, T, R, arm));
        const sum = rs.reduce((a, r) => a + r.pnl, 0);
        const trips = rs.reduce((a, r) => a + r.trips, 0);
        const win = Math.round((100 * rs.filter((r) => r.pnl > 0).length) / rs.length);
        console.log(`${arm !== undefined ? `무장+${arm.toFixed(1)}% ` : "상시     "} T=${T.toFixed(2)} R=${R.toFixed(2)}: 합 ${sum >= 0 ? "+" : ""}${sum.toFixed(1).padStart(6)}%p · 승률 ${win}%·복귀 ${trips}회`);
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
