// 화면 서술 템플릿 — "내가 뭘 하면 되는가" 중심 (발주자 문구 템플릿 확정판 2026-08-15 §A~D)
// 문구는 판정 코드→템플릿 매핑으로만 생성 — 자유 서술 금지. 템플릿 추가·수정은 발주자 승인.
// 템플릿 공백 2건 (발주자 승인 대기 — 그때까지 각주 미출력):
//   ① T2 갭하락 High/Low 진입 문구 — §A는 매수 전제. 행동어 개정(8/13 신규 숏 없음)에 맞는
//      갭하락 베팅용 할 일 문구가 없어, 보유분 방어 문구를 잠정 준용(아래 명기)했다.
//   ② R1_HALF(절반 축소) — §A R1 카드에 해당 판정 문구 없음.

export type TwoLines = { 해석: string; 할일: string } | null;

const VIRTUAL_TAIL = " (가상 — 따라 하지 않기)"; // §D: log-only 기간 모든 "할 일"에 자동 부착
const withTail = (s: string, phase: string) => s + (phase === "실사용" ? "" : VIRTUAL_TAIL);
const sgn = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

// ── §A T2 카드 각주 ──
export function t2Footnote(a: {
  grade: string; dir: "UP" | "DOWN" | null; size: string; entryPx: number | null;
  score: number; abstain: string | null; phase: string;
  blockedNoBet?: string | null;   // 등급 High/Low인데 베팅 없는 밤의 차단 사유 (DC-PM 미달 등)
}): TwoLines {
  const dirWord = a.dir === "UP" ? "갭상승" : "갭하락";
  // 등급-행동 분리 (발주자 8/18): 등급은 High/Low인데 트리거 조건(DC-PM·경제성)에 막힌 밤 — 각주도 등급 템플릿을 따르되 할 일은 "베팅 없음"
  if ((a.grade === "High" || a.grade === "Low") && a.blockedNoBet) {
    return {
      해석: `점수 ${sgn(a.score).replace("%", "")}로 ${dirWord} ${a.grade} 구간이지만, 트리거 조건 미달(${a.blockedNoBet})로 베팅하지 않음 — 등급은 점수대로, 행동만 보류`,
      할일: withTail(`지금: 없음 — ${dirWord} 경계. 내일 시가로 ${a.grade} 등급 판단이 맞았는지 채점됨`, a.phase),
    };
  }
  if (a.grade === "High" || a.grade === "Low") {
    if (a.dir === "UP") return {
      해석: `오늘 밤 갭상승 확률이 높다고 판단 — 확신 ${a.grade}`,
      할일: withTail(`저녁 지정가 ${a.entryPx ? a.entryPx.toLocaleString() + "원" : "—"}(기준가·19:40 NXT 주가) 이하로 ${a.size} 매수. 내일 아침 07:20 R1이 유지/청산을 알려줌`, a.phase),
    };
    // 갭하락 베팅 — 템플릿 공백 ①: 행동어 개정(신규 숏 없음) 잠정 준용
    return {
      해석: `오늘 밤 갭하락 확률이 높다고 판단 — 확신 ${a.grade}`,
      할일: withTail(`보유분 저녁 매도 검토 (신규 숏 없음 — 행동어 개정 준용). 내일 아침 07:20 R1 확인`, a.phase),
    };
  }
  if (a.abstain && Math.abs(a.score) >= 0.5) {
    // 보류 (금요일/이벤트/기타 규칙) — 방향이 보였던 밤
    const friday = a.abstain.includes("금요일");
    const evt = a.abstain.match(/보류1[^(]*\(([^)]+)\)/)?.[1] ?? null;
    const risk = friday ? "주말 뉴스 리스크" : evt ? `오늘 밤 ${evt} 발표` : a.abstain;
    return {
      해석: `점수 ${sgn(a.score).replace("%", "")}로 ${a.score > 0 ? "갭상승" : "갭하락"}이 보이지만, ${risk}를 안고 잘 수 없어 규칙상 쉼`,
      할일: withTail(`지금: 없음. ${friday ? "월요일" : "내일"} 시가로 '쉰 대가'가 기록됨`, a.phase),
    };
  }
  if (a.grade === "Lean" && a.dir) return {
    해석: `방향은 ${dirWord} 쪽으로 보이지만, 베팅할 만큼 확신이 서지 않음 (점수 ${sgn(a.score).replace("%", "")} < 문턱 2.5)`,
    할일: withTail(`지금: 없음. 내일 시가로 이 방향 판단이 맞았는지 채점됨 — 다음 확인: 내일 아침`, a.phase),
  };
  return {
    해석: `방향 판단 근거가 없음 — 억지로 방향을 만들지 않음`,
    할일: withTail(`지금: 없음. 내일 아침 R1만 확인`, a.phase),
  };
}

// ── §A R1 카드 각주 ──
export function r1Footnote(a: {
  code: string; line?: string; residualSigma: number | null; sigmaPct: number | null;
  fairGapPct: number | null; phase: string;
}): TwoLines {
  if (a.code === "R1_KEEP") {
    const remain = a.residualSigma != null && a.sigmaPct ? sgn(a.residualSigma * a.sigmaPct) : "—";
    return {
      해석: `밤사이 결과가 어제 베팅 방향과 일치 — 아직 ${remain} 더 남은 것으로 계산`,
      할일: withTail(`보유 유지. 09:00~09:30 사이 익절 예정 — 09:35 채점 확인`, a.phase),
    };
  }
  if (a.code === "R1_EXIT_PREOPEN") return {
    해석: `밤사이 방향이 뒤집힘 — 어제 판단은 틀린 것으로 확정`,
    할일: withTail(`프리장 08:00 즉시 전량 매도. 물타기 금지. 미련 두지 않기`, a.phase),
  };
  if (a.code === "R1_NOPOS_WATCH") {
    if (a.line?.includes("잔여분 후보")) return {
      해석: `들고 있는 것 없으나 예상 갭이 이례적으로 큼`,
      할일: withTail(`프리장 소액(1/6) 진입 후보 — 08:56 R2 확인 후 결정`, a.phase),
    };
    return {
      해석: `들고 있는 것 없음. 예상 갭 ${a.fairGapPct != null ? sgn(a.fairGapPct) : "—"}는 새로 들어갈 만큼 크지 않음 (기준 1.2σ 미달)`,
      할일: withTail(`오늘 아침 할 일 없음. 08:56 R2만 확인`, a.phase),
    };
  }
  return null; // R1_HALF — 템플릿 공백 ② (발주자 승인 대기)
}

// ── §A R2 카드 각주 (내부 코드 유지 — 표시만 쉬운 말) ──
// [발주자 지시 8/20 밤 — R2 표기] 해석 각주도 판정 줄과 동일한 3숫자(실제값·이론값·차) 사용.
export function r2Footnote(a: { code: string; residualSigma: number | null; expectedOpen: number | null; phase: string; est?: number | null }): TwoLines {
  const diff = a.est != null && a.expectedOpen != null ? a.est - a.expectedOpen : null;
  const three = (word: string) => diff != null && a.residualSigma != null
    ? `시장이 매기는 시가(${a.est!.toLocaleString()})가 이론값(${a.expectedOpen!.toLocaleString()})보다 ${Math.abs(diff).toLocaleString()}원 ${word} — 정상 편차의 ${Math.abs(a.residualSigma).toFixed(1)}배`
    : null;
  if (a.code === "R2_FADE_CANDIDATE" && a.residualSigma != null) return {
    해석: three("비쌈") ?? `시장이 시가를 이론값보다 ${Math.abs(a.residualSigma).toFixed(1)}배(정상 편차 기준) 비싸게 매기는 중`,
    할일: withTail(`시가 매수 금지. 시가 이후 밀림(되돌림) 관찰 — 조건 통과 시만 하락 베팅 후보`, a.phase),
  };
  if (a.code === "R2_OPEN_BUY") return {
    해석: three("쌈") ?? `시장이 시가를 이론값보다 싸게 매기는 중`,
    할일: withTail(`시가 매수 후보 (목표 ${a.expectedOpen ? a.expectedOpen.toLocaleString() : "이론가"}, 시한 09:30, 1/6)`, a.phase),
  };
  if (a.code === "R2_NO_SIGNAL" && a.residualSigma != null) return {
    해석: `시가가 제값으로 매겨지는 중 (차이 ${a.residualSigma}σ — 정상 범위)`,
    할일: withTail(`할 일 없음이 정답 — 억지 매매 금지`, a.phase),
  };
  return null; // 관측 결측 — 템플릿 없음
}

// ── D1 방향 축 (발주자 8/15 저녁 §1): 보류 밤을 방향 적중/오판으로 분해 ──
// 8/13 확정 사례(발주자): 본판정 오판·섀도 오판(재채점) → "방향 오판" — nf 편입 처방의 근거.
export type DirAxis = "오판" | "적중_문턱" | "적중_규칙" | "무방향";
export function dirAxisOf(a: { score: number | null; abstain: string | null; L1: number | null }): DirAxis {
  const seen = a.score != null && a.score >= 0.5 ? 1 : a.score != null && a.score <= -0.5 ? -1 : 0;
  const act = a.L1 != null && Math.abs(a.L1) >= 0.3 ? Math.sign(a.L1) : 0;
  if (!seen || !act) return "무방향";
  if (seen !== act) return "오판";
  return a.abstain?.startsWith("보류") ? "적중_규칙" : "적중_문턱";
}
export const DIR_AXIS_TAG: Record<DirAxis, string> = {
  오판: "방향 오판 (문턱 문제 아님)",
  적중_문턱: "방향 적중·문턱에 막힘",
  적중_규칙: "방향 적중·규칙(금요일 등)에 막힘",
  무방향: "방향 없음",
};

// ── §B 성적표 판결문 ──
// [발주자 재촉 8/20 밤 — 기준점 통일 완전 이행] 헤드라인 = 애프터比(진입가/기준가 기준 = L1p) 우선, 종가比 괄호.
// 채점의 자(적중 hit·L1 분류)는 종가 유지 — 이원 기록 원칙 불변. 규격 예시(발주자):
// "T2는 갭하락으로 보고 쉬었으나 실제는 애프터比 -0.19% (종가比 +3.84% 갭상승) — 쉼이 결과적으로 정답, 방향은 오판"
export function verdictSentence(a: {
  name: string; bet: boolean; gradeLabel?: string | null; dir?: string | null;
  score: number | null; abstain: string | null; L1: number | null; L1p: number | null; hit?: boolean | null;
}): string {
  const cls = a.L1 == null ? "" : Math.abs(a.L1) < 0.3 ? " 보합" : a.L1 > 0 ? " 갭상승" : " 갭하락";
  const actual = a.L1 == null ? "미채점" : `애프터比 ${a.L1p != null ? sgn(a.L1p) : "—"} (종가比 ${sgn(a.L1)}${cls})`;
  if (a.bet) {
    return `${a.name} — T2 '${a.gradeLabel ?? (a.dir === "UP" ? "갭상승" : "갭하락")}' → 실제 ${actual} — ${a.hit ? "적중" : a.hit === false ? "빗나감" : "채점 대기"} (채점 자=종가比, 가상)`;
  }
  const seen = a.score != null && a.score >= 0.5 ? "갭상승" : a.score != null && a.score <= -0.5 ? "갭하락" : "방향 없음";
  const ax = dirAxisOf({ score: a.score, abstain: a.abstain, L1: a.L1 });
  const AX_SHORT: Record<DirAxis, string> = { 오판: "방향은 오판", 적중_문턱: "방향은 적중(문턱에 막힘)", 적중_규칙: "방향은 적중(규칙에 막힘)", 무방향: "방향 판단 없음" };
  const rest = a.L1p == null ? "가상 진입가 미기록" : a.L1p > 0.3 ? `쉬어서 ${sgn(a.L1p)} 놓침(애프터比)` : "쉼이 결과적으로 정답";
  return `${a.name} — T2는 '${seen}'으로 보고 쉬었으나 실제는 ${actual} — ${rest}, ${AX_SHORT[ax]}`;
}

// ── §C 야간선물 흐름 줄 (8/18 DC-NF 첫 수집부터) ──
// 금지: 미래 예측 서술 — 흐름의 현재 상태·일관성만. 지속 경향은 "확인 중(검증 단계)" 꼬리표 필수.
export function nfFlowLines(nf: {
  bars: { t: string; pct: number }[]; level?: { pct: number } | null; dc_nf?: number | null;
}, betaSs: number, betaHx: number): string[] {
  if (!nf.bars.length) return [];
  const cum = nf.level?.pct ?? nf.bars[nf.bars.length - 1].pct;
  const lastT = nf.bars[nf.bars.length - 1].t;
  const deltas = nf.bars.map((b, i) => (i === 0 ? b.pct : b.pct - nf.bars[i - 1].pct)).filter((d) => d !== 0);
  const agree = deltas.filter((d) => Math.sign(d) === Math.sign(cum)).length;
  const cons = nf.dc_nf != null ? Math.round(nf.dc_nf * 100) : null;
  const line1 = `야간선물 흐름: 18:00 개장 → ${lastT} 현재 ${sgn(cum)} (${cum >= 0 ? "상승" : "하락"} 흐름, 10분봉 ${agree}/${deltas.length}개 동방향${cons != null ? ` = 일관성 ${cons}%` : ""})`;
  const line2 = cons == null
    ? `봉 ${deltas.length}개 — 일관성 산출 대기 (3개부터)`
    : cons >= 60
      ? `흐름이 한 방향 유지 중 — 이런 흐름은 개장까지 이어지는 경향을 확인 중(검증 단계)`
      : `방향이 오락가락 — 밤 방향 판단 재료로 부족`;
  // β값 병기 (발주자 8/18): 배율의 출처가 보이게 — "≈ 삼전 -1.62%(β1.3)·하닉 -1.87%(β1.5)"
  const line3 = `지수 ${sgn(cum)} ≈ 삼전 ${sgn(cum * betaSs)}(β${betaSs.toFixed(1)})·하닉 ${sgn(cum * betaHx)}(β${betaHx.toFixed(1)}) 상당 (β 환산)`;
  return [line1, line2, line3];
}

// ── 야간선물 표기 규격 (발주자 8/19 저녁): 모든 야간선물 수치에 "세션 밤짜 + 시각" 의무 병기 ──
// 세션 밤짜 = 세션이 시작된 저녁의 날짜 (18:00 개장일). R1(아침, 라벨일 D)의 세션 밤짜 = 직전 거래일 저녁.
const mdOf = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const sgnP = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

// 아침 R1 카드: "야간선물(8/18밤): 저녁 절단 19:35 -1.56% → 새벽 04:50 -3.97% (밤사이 하락 심화)"
export function nfSessionMorning(a: { sessionNight: string | null; cutT: string | null; cutPct: number | null; dawnT: string; dawnPct: number | null; dawnCorrected?: boolean }): string {
  const head = a.sessionNight ? `야간선물(${mdOf(a.sessionNight)}밤)` : "야간선물";
  const cut = a.cutPct != null ? `저녁 절단 ${a.cutT ?? "19:35"} ${sgnP(a.cutPct)}` : "저녁 절단 결측";
  const dawn = a.dawnPct != null ? `새벽 ${a.dawnT} ${sgnP(a.dawnPct)}${a.dawnCorrected ? "(정정)" : ""}` : "새벽 관측 결측";
  let note = "";
  if (a.cutPct != null && a.dawnPct != null) {
    const d = a.dawnPct - a.cutPct;
    if (Math.abs(d) >= 1.0) {
      const flipped = Math.sign(a.cutPct) !== Math.sign(a.dawnPct) && Math.abs(a.cutPct) >= 0.3;
      note = flipped ? " (밤사이 반전)" : ` (밤사이 ${a.dawnPct < a.cutPct ? "하락" : "상승"} 심화)`;
    }
  }
  return `${head}: ${cut} → ${dawn}${note}`;
}

// 저녁 T2 카드 흐름 줄 머리: "야간선물(8/19밤 진행중): 19:35 현재 +2.73%" — 전날 밤 값과 혼동 차단
export function nfSessionEveningHead(a: { sessionNight: string; lastT: string; cumPct: number; closed: boolean }): string {
  // [발주자 질문 8/22] 새벽 시각(00~09시)은 세션 밤짜의 익일 — "8/21밤: 8/22 05:50 현재"로 날짜를 병기해 혼동 차단
  const dawn = a.lastT < "12:00";
  const next = (() => { const d = new Date(a.sessionNight + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
  return `야간선물(${mdOf(a.sessionNight)}밤${a.closed ? "" : " 진행중"}): ${dawn ? `${mdOf(next)} ` : ""}${a.lastT} ${a.closed && dawn && a.lastT >= "06:00" ? "마감" : "현재"} ${sgnP(a.cumPct)}`;
}

// ── 기준점 통일 환산 + 상충 플래그 v2 (발주자 판정 8/19 밤) ──
// 기준점 = 정규장 종가(15:30) 확정. 잔여갭 경로 시가 예상 = NXT가 × (1+잔여갭) / 정규 종가 − 1.
// 3자: ⓐ 룰 방향(GapScore 부호) ⓑ 잔여갭 경로 시가 예상 ⓒ 야간선물 β환산 — 어느 쌍이든 방향 불일치 또는 크기 괴리 ≥2%p → 상충.
export type ConflictV2 = {
  regClose: number | null; openExp_resid: number | null; openExp_nf: number | null; ruleSign: number;
  pairs: string[]; divergence_pp: number | null; conflict: boolean;
};
export function conflictV2(a: { gapScore: number | null; residGap: number | null; nxtPx: number | null; rNxt: number | null; nfLevel: number | null }): ConflictV2 {
  const regClose = a.nxtPx != null && a.rNxt != null ? Math.round(a.nxtPx / (1 + a.rNxt / 100)) : null;
  const openExp_resid = a.residGap != null && a.rNxt != null ? Math.round(((1 + a.rNxt / 100) * (1 + a.residGap / 100) - 1) * 10000) / 100 : null;
  const openExp_nf = a.nfLevel != null ? Math.round(a.nfLevel * 100) / 100 : null;
  const ruleSign = a.gapScore != null && Math.abs(a.gapScore) >= 0.5 ? Math.sign(a.gapScore) : 0;
  const pairs: string[] = [];
  const sgnOf = (v: number | null) => (v == null || Math.abs(v) < 0.3 ? 0 : Math.sign(v));
  if (openExp_resid != null && openExp_nf != null) {
    const dirMis = sgnOf(openExp_resid) !== 0 && sgnOf(openExp_nf) !== 0 && sgnOf(openExp_resid) !== sgnOf(openExp_nf);
    if (dirMis || Math.abs(openExp_resid - openExp_nf) >= 2) pairs.push("NXT vs 야간선물");
  }
  if (ruleSign !== 0 && openExp_resid != null && sgnOf(openExp_resid) !== 0 && sgnOf(openExp_resid) !== ruleSign) pairs.push("룰 vs NXT");
  if (ruleSign !== 0 && openExp_nf != null && sgnOf(openExp_nf) !== 0 && sgnOf(openExp_nf) !== ruleSign) pairs.push("룰 vs 야간선물");
  const divergence_pp = openExp_resid != null && openExp_nf != null ? Math.round(Math.abs(openExp_resid - openExp_nf) * 100) / 100 : null;
  return { regClose, openExp_resid, openExp_nf, ruleSign, pairs, divergence_pp, conflict: pairs.length > 0 };
}
// 병기 표기 (발주자 확정): "≈ 내일 시가 예상 -0.3% (정규 종가 1,500,000 대비)"
export function openExpText(pct: number | null, regClose: number | null): string {
  if (pct == null) return "≈ 내일 시가 예상 — (환산 불가)";
  return `≈ 내일 시가 예상 ${sgn(pct)}${regClose ? ` (정규 종가 ${regClose.toLocaleString()} 대비)` : ""}`;
}

// ── 기준점 통일 v2 (발주자 ■7 8/20 — 기발주 재확인): 표시 = "애프터比(T2 19:40 기준가)" 단일화 + (종가比) 병기 ──
// 규격: "+4.2% 애프터比 (종가比 +6.1%)". 공식 채점(TE·Lean·게이트)은 종가 자 유지(60일 검증 불변) —
// 애프터比 채점은 병행 저장(labels.after_basis), D+60에 자 전환 여부 발주자 결정.
export function dualBasis(a: { afterPct: number | null; closePct: number | null }): string {
  const f = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
  if (a.afterPct == null && a.closePct == null) return "—";
  if (a.afterPct == null) return `${f(a.closePct)} 종가比 (애프터比 산출 불가)`;
  return `${f(a.afterPct)} 애프터比 (종가比 ${f(a.closePct)})`;
}
// 갭 %를 애프터比로 환산: (1+종가比)/(1+애프터마진) − 1, 애프터마진 = 기준가/종가 − 1
export function toAfterBasis(closeBasisPct: number | null, entryPx: number | null, regClose: number | null): number | null {
  if (closeBasisPct == null || !entryPx || !regClose || regClose <= 0) return null;
  const m = entryPx / regClose;
  return Math.round(((1 + closeBasisPct / 100) / m - 1) * 10000) / 100;
}
export const BIG_AFTER_BADGE = (closePct: number | null, afterPct: number | null) =>
  closePct != null && afterPct != null && Math.abs(closePct - afterPct) >= 3 ? "⚡애프터 대변동 밤" : null;

// ── 승인(勝因) 코멘트 (발주자 발주 보강 8/24 ■5) — 템플릿 자동 생성, 자유 서술 금지 ──
// 조립 규칙: ①승자(실측 최근접)의 거리를 가장 줄인 성분 특정 ②패자(최대 오차)의 원인 성분+빗나간 방향
// ③고정 템플릿 ④특수 밤 태그는 호출부가 tags로 병기 ⑤1·2위 오차차 <0.3pp = "혼전" 정직 표기 (억지 서사 금지).
export type TrackObs = {
  key: string;                    // 표기명: T2 / v2 / v2.1 / T2아침 / R1 / v1.1c ...
  pct: number | null;             // 최종 예상갭 (종가比)
  basePct?: number | null;        // v2 계열: 야간선물 base(β환산 종목 종가比) — base vs drift 기여 분해용
  nxtPct?: number | null;         // T2 계열: NXT 기반영(애프터 유지 시 종가比) — 잔여갭 차감항 분해용
  experts?: Record<string, number> | null; // R1/v1.1c: 전문가별 예측치 (nf 포함 가능) — 기여 분해용
};
const fpp = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
function winnerReason(t: TrackObs, actual: number): string {
  const finalErr = Math.abs((t.pct ?? 0) - actual);
  if (t.basePct != null) {
    // v2 계열: drift 조정이 base보다 실측에 다가갔으면 drift 주역, 아니면 base 주역
    const baseErr = Math.abs(t.basePct - actual);
    return finalErr <= baseErr - 0.05
      ? `drift 조정(${fpp(t.basePct)}→${fpp(t.pct!)})이 거리 축소`
      : `야간선물 base(${fpp(t.basePct)})가 실측(${fpp(actual)})에 근접`;
  }
  if (t.nxtPct != null) {
    const nxtErr = Math.abs(t.nxtPct - actual);
    return finalErr <= nxtErr - 0.05
      ? `잔여갭 차감항(${fpp(t.nxtPct)}→${fpp(t.pct!)})이 거리 축소`
      : `NXT 기반영(${fpp(t.nxtPct)})이 실측에 근접`;
  }
  if (t.experts) {
    const best = Object.entries(t.experts).sort((a, b) => Math.abs(a[1] - actual) - Math.abs(b[1] - actual))[0];
    if (best) return `${best[0]} 전문가(${fpp(best[1])})가 실측에 근접`;
  }
  return `결합 추정(${fpp(t.pct!)})이 실측에 근접`;
}
function loserReason(t: TrackObs, actual: number): string {
  const miss = (t.pct ?? 0) - actual;
  const dir = miss > 0 ? "상방 과대" : "하방 과대";
  const finalErr = Math.abs(miss);
  if (t.basePct != null) {
    const baseErr = Math.abs(t.basePct - actual);
    return finalErr > baseErr + 0.05
      ? `drift 조정이 악화(${fpp(t.basePct)}→${fpp(t.pct!)})`
      : `base(β 경유)가 ${dir}`;
  }
  if (t.nxtPct != null) {
    const nxtErr = Math.abs(t.nxtPct - actual);
    return finalErr > nxtErr + 0.05
      ? `잔여갭 차감항이 애프터 경로를 놓침(${fpp(t.nxtPct)}→${fpp(t.pct!)})`
      : `NXT 경로 자체가 ${dir}`;
  }
  if (t.experts) {
    const worst = Object.entries(t.experts).sort((a, b) => Math.abs(b[1] - actual) - Math.abs(a[1] - actual))[0];
    if (worst) return `${worst[0]} 전문가(${fpp(worst[1])})가 ${dir}`;
  }
  return `결합 추정이 ${dir}`;
}
export function winComment(a: { actual: number | null; tracks: TrackObs[]; tags: string[] }): string | null {
  if (a.actual == null) return null;
  const valid = a.tracks.filter((t) => t.pct != null);
  if (valid.length < 2) return null; // 단독 트랙 밤 — 대결 서사 없음
  const sorted = [...valid].sort((x, y) => Math.abs(x.pct! - a.actual!) - Math.abs(y.pct! - a.actual!));
  const tag = a.tags.length ? a.tags.join(" ") + " " : "";
  const w = sorted[0], second = sorted[1], l = sorted[sorted.length - 1];
  const wErr = Math.abs(w.pct! - a.actual), sErr = Math.abs(second.pct! - a.actual);
  if (sErr - wErr < 0.3) return `${tag}혼전 — 단일 승인 특정 불가 (1·2위 오차차 ${(sErr - wErr).toFixed(2)}pp)`;
  return `${tag}${w.key} 승 — ${winnerReason(w, a.actual)} (오차 ${wErr.toFixed(2)}pp). ${l.key}는 ${loserReason(l, a.actual)} (${fpp(l.pct!)} 예상, 오차 ${Math.abs(l.pct! - a.actual).toFixed(2)}pp).`;
}
