// M7 근사 모델 — 현행 레버리지·인버스 판정(축1 Bias × 축2 Confirmation + 게이트)의
// 과거 재구성 가능한 골격만으로 만든 근사. 대가 모델과 같은 잣대(220일·동일 라벨) 비교 목적.
//
// ⚠ 근사의 한계 (정직 고지): 수급(T4·T5·T8 FKS200)·미국 뉴스 영향도(L7)·이벤트(C1)·
// 지표 서프라이즈(L10)·프로그램(B1)은 과거 장중 시계열이 없어 제외. 즉 이 모델의 성적은
// "M7의 매크로+가격 골격"의 성적이지 운영 중인 M7 전체의 성적이 아니다.
//
// 축1 Bias 근사 (전일·간밤, 마스터 2.2 개정 반영): SOX 가중2 (±0.5%) · 환율 (±0.3%) ·
//   미 금리 (±0.03%p — 2Y 이력 부재로 10Y 근사)
// 축2 Confirmation 근사 (장중, 해당 종목 분봉): T6 산·골 스윙(실엔진) + 시가 대비 방향 +
//   DC2 효율비(Kaufman ER)
// 게이트: LM 절대 레벨(10Y ≥4.6% 또는 환율 ≥1,540 — 2026-07-16 개정) → 레버리지 금지,
//   X1(갭 +2% 초과 추격 금지), XS1(직전 1~3일 누적 -12% 폭락 후 인버스 금지)

import { computeSwingStructure } from "../../signal/engine/trend";
import { atrPct } from "../indicators";
import type { DayInput, ModelOutput } from "../types";

export function runM7Proxy(input: DayInput): ModelOutput {
  const model = "m7" as const;
  const prev = input.dailyHistory[input.dailyHistory.length - 1];
  if (!prev || input.morning.length < 30) return { model, verdict: "none", confidence: 0.3, reason: "데이터 부족" };
  const m = input.macro ?? null;

  // ── 축1 Bias 투표
  let up = 0, down = 0;
  const notes: string[] = [];
  if (m?.soxPrevChg != null) {
    if (m.soxPrevChg >= 0.5) { up += 2; notes.push(`SOX +${m.soxPrevChg.toFixed(1)}%`); }
    else if (m.soxPrevChg <= -0.5) { down += 2; notes.push(`SOX ${m.soxPrevChg.toFixed(1)}%`); }
  }
  if (m?.usdkrwPrevChg != null) {
    if (m.usdkrwPrevChg >= 0.3) { down += 1; notes.push("환율↑"); }
    else if (m.usdkrwPrevChg <= -0.3) { up += 1; notes.push("환율↓"); }
  }
  if (m?.us10yPrevPp != null) {
    if (m.us10yPrevPp >= 0.03) { down += 1; notes.push("금리↑"); }
    else if (m.us10yPrevPp <= -0.03) { up += 1; notes.push("금리↓"); }
  }
  const bias: "상방" | "하방" | "중립" = up > down ? "상방" : down > up ? "하방" : "중립";

  // ── 게이트
  const lmBlock = (m?.us10yLevel ?? 0) >= 4.6 || (m?.usdkrwLevel ?? 0) >= 1540;
  const gapPct = ((input.openPx - prev.close) / prev.close) * 100;
  // X1 변동성 연동 (2026-07-20): max(3%, 0.5×ATR14) — 고정 2%는 고변동장에서 과다 차단
  const atrForGap = atrPct(input.dailyHistory, 14) ?? 0;
  const x1Block = gapPct > Math.max(3, 0.5 * atrForGap);
  // XS1: 직전 1~3일 누적 -12% 이상 폭락
  let crash = false;
  const h = input.dailyHistory;
  for (let k = 1; k <= 3 && h.length > k; k++) {
    const base = h[h.length - 1 - k].close;
    if (((h[h.length - 1].close - base) / base) * 100 <= -12) { crash = true; break; }
  }

  // ── 축2 Confirmation (장중)
  const closes = input.morning.map((b) => b.close);
  const last = closes[closes.length - 1];
  const m5: { min: number; px: number }[] = [];
  for (let i = 4; i < input.morning.length; i += 5) m5.push({ min: i, px: input.morning[i].close });
  const swing = m5.length >= 4 ? computeSwingStructure(m5) : null;
  const netMove = Math.abs(last - closes[0]);
  const pathSum = closes.reduce((a, c, i) => (i ? a + Math.abs(c - closes[i - 1]) : a), 0);
  const er = pathSum > 0 ? netMove / pathSum : 0; // DC2 효율비
  const pxDir: 1 | -1 = last >= input.openPx ? 1 : -1;
  const movePct = (Math.abs(last - input.openPx) / input.openPx) * 100;
  let axis2: "상방" | "하방" | "미확인" = "미확인";
  if (swing?.status === "추세" && swing.dir === "UP" && pxDir === 1) axis2 = "상방";
  else if (swing?.status === "추세" && swing.dir === "DOWN" && pxDir === -1) axis2 = "하방";
  else if (er >= 0.35 && movePct >= 0.8) axis2 = pxDir === 1 ? "상방" : "하방"; // 스윙 미확정 시 효율비 보조

  const biasStr = `축1 ${bias}${notes.length ? `(${notes.join("·")})` : ""}`;
  const axisStr = `축2 ${axis2}(스윙 ${swing?.status ?? "-"}·ER ${er.toFixed(2)})`;

  // ── 판정: 축1·축2 정렬 + 게이트 (마스터의 "Bias 역행 진입 금지" 골격)
  if (axis2 === "상방" && bias !== "하방") {
    if (lmBlock) return { model, verdict: "none", confidence: 0.6, reason: `LM 게이트 차단 — ${biasStr}·${axisStr}` };
    if (x1Block) return { model, verdict: "none", confidence: 0.55, reason: `X1 갭 추격 금지 (+${gapPct.toFixed(1)}%) — ${axisStr}` };
    return { model, verdict: "leverage", confidence: bias === "상방" ? 0.75 : 0.6, reason: `${biasStr} · ${axisStr}` };
  }
  if (axis2 === "하방" && bias !== "상방") {
    if (crash) return { model, verdict: "none", confidence: 0.6, reason: `XS1 폭락 후 인버스 금지 — ${axisStr}` };
    return { model, verdict: "inverse", confidence: bias === "하방" ? 0.75 : 0.6, reason: `${biasStr} · ${axisStr}` };
  }
  return { model, verdict: "none", confidence: 0.5, reason: `축 불일치 또는 미확인 — ${biasStr} · ${axisStr}` };
}
