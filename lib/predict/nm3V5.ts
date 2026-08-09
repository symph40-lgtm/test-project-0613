// NM3 트랙 A W1 — V5 페이퍼 궤도 통계화 (신뢰대역 + SPRT).
// 근거: NM3 v0.2 §4, IMPL_SPEC_TrackA §B, 발주자 결정 D-1(μ_bt = 비용 차감 기준)·D-2(착수 지시).
// 순수 함수·결정론(같은 rows → 같은 판정), 채점은 읽기만. μ·σ·c̄는 상수 — 코드 내 재추정 금지,
// 변경은 IMPL_SPEC 개정으로만 (산출: scripts/nm3-v.ts 2026-08-10, 기본 슬리피지 국장 0.02·SOXX 0.03%/변).
// 페이퍼 채점 p는 그로스이므로 비교 시 일평균 비용 c̄를 차감해 순 기준으로 정합시킨다
// (근사 — 일별 실제 변 수 기록은 W2 variant 열 도입 후 정밀화).

export type V5Const = { mu: number; sigma: number; cbar: number };
export const V5_CONST: Record<"hx" | "ss" | "soxx", V5Const> = {
  hx: { mu: 0.5213, sigma: 2.5271, cbar: 0.0249 },   // 본주 %p/일 (218일)
  ss: { mu: 0.4879, sigma: 2.7991, cbar: 0.0421 },   // 본주 %p/일 (218일)
  soxx: { mu: 0.4819, sigma: 2.2123, cbar: 0.0720 }, // SOXX %p/일 (250일)
};

// SPRT: H0 μ=μ_bt(궤도 유지) vs H1 μ=0(에지 소멸), 공통 σ, α=β=0.1.
// LLR = Σ [(x−μ_bt)² − x²] / (2σ²) — 양수로 커지면 H1 쪽 증거.
const SPRT_A = Math.log(0.9 / 0.1); // +2.197 → H1 수용 (에지 소멸 의심 — 중단·재검)
const SPRT_B = Math.log(0.1 / 0.9); // -2.197 → H0 수용 (궤도 유지 — 승격 근거 충족)

export type V5State = {
  n: number; cum: number;           // 순 기준 누적 (그로스 − n·c̄)
  z: number;                        // (cum − n·μ) / (σ√n) — 대역 내 위치
  band: "정상" | "주의(90%)" | "재검(99%)" | "상회";
  llr: number; sprt: "계속" | "중단재검" | "궤도유지";
};

export function v5State(grossDaily: number[], c: V5Const): V5State | null {
  const n = grossDaily.length;
  if (n < 5) return null; // 극초반 판정 유보
  const net = grossDaily.map((x) => x - c.cbar);
  const cum = net.reduce((a, b) => a + b, 0);
  const z = (cum - n * c.mu) / (c.sigma * Math.sqrt(n));
  const band: V5State["band"] = z <= -2.576 ? "재검(99%)" : z <= -1.645 ? "주의(90%)" : z >= 1.645 ? "상회" : "정상";
  let llr = 0;
  for (const x of net) llr += ((x - c.mu) ** 2 - x ** 2) / (2 * c.sigma ** 2);
  const sprt: V5State["sprt"] = llr >= SPRT_A ? "중단재검" : llr <= SPRT_B ? "궤도유지" : "계속";
  return { n, cum, z, band, llr, sprt };
}

// 채점 장기 백업 병합 (§B3 DoD④ — 라이브 키는 slice(-120) 절단이므로 `<key>_full`에 전량 보존).
// 순수 병합: 기존 full에서 kept와 겹치는 날짜만 갱신, 날짜순 정렬.
export function mergeFull<T extends { date: string }>(existing: unknown, kept: T[]): T[] {
  const prev = Array.isArray(existing) ? (existing as T[]) : [];
  const dates = new Set(kept.map((k) => k.date));
  return [...prev.filter((r) => r && typeof r.date === "string" && !dates.has(r.date)), ...kept].sort((a, b) => (a.date < b.date ? -1 : 1));
}

// 결산 문자 병기 1줄 (수동 눈대중 판독 폐지 — v0.2 §4). null(표본 <5일)이면 빈 문자열.
export function v5Line(grossDaily: number[], key: keyof typeof V5_CONST): string {
  const st = v5State(grossDaily, V5_CONST[key]);
  if (!st) return "";
  const s = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
  return `궤도(V5·순): ${st.n}일 ${s(st.cum)}%p · 대역 ${st.band}(z${st.z.toFixed(1)}) · SPRT ${st.sprt}(LLR ${st.llr.toFixed(2)})`;
}
