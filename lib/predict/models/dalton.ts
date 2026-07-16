// 스타이들마이어·달튼 — 전일 가치영역(Value Area) + 시가 유형(Open Type). 스펙 2.4절.
// 원전: Mind Over Markets. 시가 유형 규칙은 ext-modules O1(2.2절)과 동일 파라미터.
// VA 밖 개장 + 이탈 방향 드라이브 + 수용(10:00에도 밖) = 추세일. 80% 룰 역매매는 채택하지 않음.

import { PREDICT_CONFIG } from "../config";
import { minuteAtOrBefore } from "../indicators";
import type { DayInput, MinuteBar, ModelOutput } from "../types";

type OpenType = "open_drive" | "open_test_drive" | "open_auction" | "undetermined";

function valueArea(bars: MinuteBar[], binWon: number, vaPct: number): { poc: number; vah: number; val: number } | null {
  const vol = new Map<number, number>();
  let total = 0;
  for (const b of bars) {
    const bin = Math.round(b.close / binWon) * binWon;
    const v = b.volume > 0 ? b.volume : 1; // 거래량 0 봉도 체결 흔적으로 최소 가중
    vol.set(bin, (vol.get(bin) ?? 0) + v);
    total += v;
  }
  if (vol.size === 0 || total <= 0) return null;
  const bins = [...vol.keys()].sort((a, b) => a - b);
  let pocIdx = 0;
  bins.forEach((p, i) => { if ((vol.get(p) ?? 0) > (vol.get(bins[pocIdx]) ?? 0)) pocIdx = i; });
  let loIdx = pocIdx, hiIdx = pocIdx;
  let acc = vol.get(bins[pocIdx]) ?? 0;
  while (acc < vaPct * total && (loIdx > 0 || hiIdx < bins.length - 1)) {
    const below = loIdx > 0 ? vol.get(bins[loIdx - 1]) ?? 0 : -1;
    const above = hiIdx < bins.length - 1 ? vol.get(bins[hiIdx + 1]) ?? 0 : -1;
    if (above >= below) { hiIdx++; acc += above; } else { loIdx--; acc += below; }
  }
  return { poc: bins[pocIdx], vah: bins[hiIdx], val: bins[loIdx] };
}

function classifyOpen(morning: MinuteBar[], openPx: number, endHHMM: string): { type: OpenType; finalDir: 1 | -1 | 0 } {
  const cfg = PREDICT_CONFIG.dalton;
  const win = morning.filter((b) => b.time < endHHMM);
  if (win.length < 10) return { type: "undetermined", finalDir: 0 };
  let crosses = 0;
  let prevSide = 0;
  for (const b of win) {
    const side = b.close > openPx ? 1 : b.close < openPx ? -1 : prevSide;
    if (prevSide !== 0 && side !== 0 && side !== prevSide) crosses++;
    if (side !== 0) prevSide = side;
  }
  const endPx = win[win.length - 1].close;
  const movePct = (Math.abs(endPx - openPx) / openPx) * 100;
  const finalDir: 1 | -1 | 0 = endPx > openPx ? 1 : endPx < openPx ? -1 : 0;
  const adverse =
    finalDir >= 0
      ? ((openPx - Math.min(...win.map((b) => b.low))) / openPx) * 100
      : ((Math.max(...win.map((b) => b.high)) - openPx) / openPx) * 100;
  if (crosses === 0 && movePct >= cfg.driveMinPct) return { type: "open_drive", finalDir };
  if (crosses <= 2 && adverse <= cfg.testMaxPct && finalDir !== 0) return { type: "open_test_drive", finalDir };
  if (crosses >= cfg.auctionCrosses) return { type: "open_auction", finalDir };
  return { type: "undetermined", finalDir };
}

export function runDalton(input: DayInput): ModelOutput {
  const cfg = PREDICT_CONFIG.dalton;
  const model = "dalton" as const;
  if (input.morning.length < 15) return { model, verdict: "none", confidence: 0.3, reason: "데이터 부족" };

  const va = input.prevDayMinutes && input.prevDayMinutes.length > 100
    ? valueArea(input.prevDayMinutes, cfg.vaBinWon, cfg.vaPct)
    : null;
  const { type, finalDir } = classifyOpen(input.morning, input.openPx, cfg.openTypeWindowEnd);
  const typeKo: Record<OpenType, string> = {
    open_drive: "드라이브", open_test_drive: "테스트드라이브", open_auction: "경매(양방향)", undetermined: "미판정",
  };

  if (!va) {
    // 전일 분봉 없음 — 시가 유형만으로 보수 판정
    if (type === "open_drive" && finalDir !== 0) {
      return { model, verdict: finalDir > 0 ? "leverage" : "inverse", confidence: 0.55, reason: `VA 없음 · 시가 ${typeKo[type]}` };
    }
    return { model, verdict: "none", confidence: 0.45, reason: `전일 가치영역 산출 불가 · 시가 ${typeKo[type]}` };
  }

  const openLoc: "above" | "inside" | "below" = input.openPx > va.vah ? "above" : input.openPx < va.val ? "below" : "inside";
  const at1000 = minuteAtOrBefore(input.morning, cfg.acceptCheck);
  const last = input.morning[input.morning.length - 1].close;
  const vaStr = `VA ${Math.round(va.val)}~${Math.round(va.vah)}`;

  if (openLoc !== "inside") {
    const awayDir = openLoc === "above" ? 1 : -1;
    const accepted = at1000 !== null && (openLoc === "above" ? at1000.close > va.vah : at1000.close < va.val);
    const stillOut = openLoc === "above" ? last > va.vah : last < va.val;
    const driveAway = (type === "open_drive" || type === "open_test_drive") && finalDir === awayDir;
    if (accepted && stillOut && driveAway) {
      const conf = type === "open_drive" ? 0.85 : 0.75;
      return {
        model,
        verdict: awayDir > 0 ? "leverage" : "inverse",
        confidence: conf,
        reason: `${vaStr} ${openLoc === "above" ? "위" : "아래"} 개장 + ${typeKo[type]} + 수용 유지`,
      };
    }
    if (!stillOut) return { model, verdict: "none", confidence: 0.55, reason: `${vaStr} 밖 개장했으나 VA 복귀(거부)` };
    return { model, verdict: "none", confidence: 0.5, reason: `${vaStr} 밖 개장 · 수용 미확인 (시가 ${typeKo[type]})` };
  }

  if (type === "open_auction") return { model, verdict: "none", confidence: 0.7, reason: `VA 안 개장 + 경매형 — 횡보 우세` };
  if (type === "open_drive" && finalDir !== 0) {
    return { model, verdict: finalDir > 0 ? "leverage" : "inverse", confidence: 0.55, reason: `VA 안 개장이나 ${typeKo[type]}` };
  }
  return { model, verdict: "none", confidence: 0.5, reason: `VA 안 개장 · 시가 ${typeKo[type]}` };
}
