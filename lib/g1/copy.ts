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
}): TwoLines {
  const dirWord = a.dir === "UP" ? "갭상승" : "갭하락";
  if (a.grade === "High" || a.grade === "Low") {
    if (a.dir === "UP") return {
      해석: `오늘 밤 갭상승 확률이 높다고 판단 — 확신 ${a.grade}`,
      할일: withTail(`저녁 지정가 ${a.entryPx ? a.entryPx.toLocaleString() : "—"} 이하로 ${a.size} 매수. 내일 아침 07:20 R1이 유지/청산을 알려줌`, a.phase),
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
export function r2Footnote(a: { code: string; residualSigma: number | null; expectedOpen: number | null; phase: string }): TwoLines {
  if (a.code === "R2_FADE_CANDIDATE" && a.residualSigma != null) return {
    해석: `시장이 시가를 이론값보다 ${Math.abs(a.residualSigma).toFixed(1)}배(정상 편차 기준) 비싸게 매기는 중`,
    할일: withTail(`시가 매수 금지. 시가 이후 밀림(되돌림) 관찰 — 조건 통과 시만 하락 베팅 후보`, a.phase),
  };
  if (a.code === "R2_OPEN_BUY") return {
    해석: `시장이 시가를 이론값보다 싸게 매기는 중`,
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
export function verdictSentence(a: {
  name: string; bet: boolean; gradeLabel?: string | null; dir?: string | null;
  score: number | null; abstain: string | null; L1: number | null; L1p: number | null; hit?: boolean | null;
}): string {
  const actual = a.L1 == null ? "미채점" : Math.abs(a.L1) < 0.3 ? `보합 ${sgn(a.L1)}` : a.L1 > 0 ? `갭상승 ${sgn(a.L1)}` : `갭하락 ${sgn(a.L1)}`;
  if (a.bet) {
    return `${a.name} — T2 '${a.gradeLabel ?? (a.dir === "UP" ? "갭상승" : "갭하락")}' → 실제 ${actual} — ${a.hit ? "적중" : a.hit === false ? "빗나감" : "채점 대기"}, 진입가 기준 ${a.L1p != null ? sgn(a.L1p) : "—"} (가상)`;
  }
  const seen = a.score != null && a.score >= 0.5 ? "갭상승" : a.score != null && a.score <= -0.5 ? "갭하락" : "방향 없음";
  const tag = DIR_AXIS_TAG[dirAxisOf({ score: a.score, abstain: a.abstain, L1: a.L1 })];
  const money = a.L1p != null ? `저녁 가격에 들어갔다면 ${sgn(a.L1p)} ${a.L1p >= 0 ? "벌었을" : "잃었을"} 밤` : "가상 진입가 미기록";
  return `${a.name} — T2는 '${seen}'으로 보고 쉬었으나 실제는 ${actual}. ${money} → ${tag}`;
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
  const line3 = `지수 ${sgn(cum)} ≈ 삼전 ${sgn(cum * betaSs)}·하닉 ${sgn(cum * betaHx)} 상당 (β 환산)`;
  return [line1, line2, line3];
}
