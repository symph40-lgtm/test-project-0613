// 계층 전략 정찰 비중 w 스윕 (사용자 질문 2026-08-01 "공통 100%, 피셔F 일때는 ?"):
//   npx tsx scripts/hier-weight-sweep.ts
// 실행 규칙 (스윙 크기는 사후 정보라 조건에서 제외 — 판정 상태만 사용):
//   ① 피셔F 첫 판정 → w% 진입 (판정가 앵커 스탑 -2.5%)
//   ② 창판정(6봉·라이브) 같은 방향 확인 → +(100-w)%p 증액 (확인가 앵커 스탑 -2.5%)
//   ③ 창판정 반대 방향 → F분 그 자리 청산, 창 방향 100% 진입
//   ④ 창판정이 먼저면 바로 100% (이후 F 동의는 무변화·F 반대는 무시 — 이견일 창 우위 실측 근거)
//   ⑤ 트랜치별 스탑 도달 시 그 트랜치만 -2.5% 확정, 나머지는 종가 청산
// 하닉 227일. 기준선: F 단독 100%(+76.2p)·창 단독 100%(+83.4p).

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

function fisherFirst(bars: MinuteBar[], r10: number): { dir: 1 | -1; i: number; px: number } | null {
  if (bars.length < 16) return null;
  const orH = Math.max(...bars.slice(0, 15).map((b) => b.high));
  const orL = Math.min(...bars.slice(0, 15).map((b) => b.low));
  let up = 0, dn = 0;
  const emUntil = tMin("10:30");
  for (let i = 15; i < bars.length; i++) {
    const b = bars[i];
    const em = tMin(b.time) < emUntil ? 3 : 1;
    const aUp = orH + 0.05 * r10 * em, aDn = orL - 0.05 * r10 * em, sbW = 0.1 * r10 * em;
    up = b.close > aUp ? up + 1 : 0;
    dn = b.close < aDn ? dn + 1 : 0;
    if (b.close > aUp + sbW) up = Math.max(up, 4);
    if (b.close < aDn - sbW) dn = Math.max(dn, 4);
    if (up >= 4) return { dir: 1, i, px: b.close };
    if (dn >= 4) return { dir: -1, i, px: b.close };
  }
  return null;
}

// 트랜치: 진입가 앵커 스탑 -2.5%, 강제 청산 인덱스(forceI, 반대 전환 등) 전이면 그 가격으로 청산
function tranchePnl(bars: MinuteBar[], i0: number, dir: 1 | -1, px: number, size: number, close: number, forceI?: number, forcePx?: number): number {
  const s = 2.5 / 100;
  const lim = forceI ?? bars.length;
  for (let k = i0 + 1; k < lim; k++) {
    const b = bars[k];
    if (dir === 1 ? b.low <= px * (1 - s) : b.high >= px * (1 + s)) return -2.5 * size;
  }
  const px2 = forceI !== undefined ? (forcePx ?? bars[lim - 1]?.close ?? close) : close;
  return ((px2 - px) / px) * 100 * dir * size;
}

async function main() {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const daily = (await fetchDailyPredict("000660", 500)).filter((b) => b.date < today);
  type Day = { bars: MinuteBar[]; close: number; fJ: ReturnType<typeof fisherFirst>; cw: { i: number; dir: 1 | -1; px: number } | null };
  const days: Day[] = [];
  for (let i = 130; i < daily.length; i++) {
    const reg = rc(`000660-${daily[i].date}.json`);
    const pre = rc(`000660NX-${daily[i].date}.json`);
    const hist = daily.slice(Math.max(0, i - 120), i);
    const r10 = avgRange(hist, 10);
    if (!reg || reg.length < 240 || r10 === null) continue;
    const bars = [...(pre ?? []), ...reg];
    const trs = candleJudgeStream(bars, unitArr(bars, r10));
    days.push({
      bars, close: daily[i].close,
      fJ: fisherFirst(bars, r10),
      cw: trs.length ? { i: trs[0].i, dir: trs[0].to === "up" ? 1 : -1, px: trs[0].px } : null,
    });
  }
  for (const w of [0, 0.2, 0.3, 0.5, 0.7, 1.0]) {
    let total = 0;
    const dayPnls: number[] = [];
    for (const d of days) {
      let pnl = 0;
      const { bars, close, fJ, cw } = d;
      const fFirstEarlier = fJ && (!cw || fJ.i < cw.i);
      if (fFirstEarlier && fJ) {
        if (cw && cw.dir !== fJ.dir) {
          // 이견: F분은 창 반대 판정 시점 청산 → 창 방향 100%
          pnl += tranchePnl(bars, fJ.i, fJ.dir, fJ.px, w, close, cw.i, cw.px);
          pnl += tranchePnl(bars, cw.i, cw.dir, cw.px, 1.0, close);
        } else {
          pnl += tranchePnl(bars, fJ.i, fJ.dir, fJ.px, w, close);
          if (cw) pnl += tranchePnl(bars, cw.i, cw.dir, cw.px, 1.0 - w, close); // 공통: 증액분
        }
      } else if (cw) {
        pnl += tranchePnl(bars, cw.i, cw.dir, cw.px, 1.0, close); // 창 선행(또는 F 무판정): 바로 100%
      }
      total += pnl;
      dayPnls.push(pnl);
    }
    const traded = dayPnls.filter((v) => v !== 0).length;
    const worst = Math.min(...dayPnls);
    console.log(`w=${(w * 100).toFixed(0).padStart(3)}%: 합 ${total >= 0 ? "+" : ""}${total.toFixed(1).padStart(6)}%p · 매매일 ${traded} · 최악일 ${worst.toFixed(2)}%`);
  }
  console.log("\n주: w=0 = 창판정 확인일만 100% (F 정찰 없음), w=100 = F 판정 즉시 100%.");
  console.log("기준선(동일 지표): F 단독 100% +76.2%p(206일) · 창 단독 100% +83.4%p(130일).");
}
main().catch((e) => { console.error(e); process.exit(1); });
