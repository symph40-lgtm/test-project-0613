// 장중 레짐 4분면 (사용자 지시 2026-07-25, 별도 문자 승격 — 같은 날 2차 지시): 개장 전에 확정되는
// 두 축으로 오늘의 운영 모드를 판정하고, 유사 레짐일의 실측 통계와 비중 결론까지 담은 독립 브리핑.
//   축1 변동성: vol10(10일 평균폭/전일 종가)이 과거 60거래일 추적 66.7분위 이상 = 고변동
//               (하닉 트레일 반전 가동 기준과 동일 — indicators.isHighVolDay)
//   축2 추세성: 전일 라벨(±1.2% 3분류)이 방향이었나
// 지침 근거: 레짐 격자 실측(스펙 2.11) — 전일 추세일 강세 4/4 (하닉 64%·삼전 67%), 무추세 다음날
// 삼전 49%로 급락, 고변동 구간 스탑 경제성 열위(2.13). 유사일 통계는 매일 일봉으로 재계산(살아있는 수치).

import { fetchDailyPredict } from "./data";
import { isHighVolDay } from "./indicators";
import { labelDay } from "./label";
import type { PredictDailyBar } from "./types";

const QUAD = {
  1: { name: "저변동·전일추세", insight: "유사일 성과 최상 구간 — 표준 운영", conclude: "계획 비중 100% 사다리(50→80→100)" },
  2: { name: "저변동·전일무추세", insight: "무추세 다음날 — 첫 신호 적중 저하(삼전 49% 실측), 과신 금지", conclude: "계획 비중 50%·첫 신호 소액" },
  3: { name: "고변동·전일추세", insight: "방향은 잦으나 폭 큼 — 되돌림이 스탑 관통 가능, 분할 진입·스탑 엄수", conclude: "표준 비중·분할 진입" },
  4: { name: "고변동·전일무추세", insight: "고변동 왕복 위험 — 격자 실측 성과 열위, 본피셔 확정만 신뢰", conclude: "계획 비중 1/3 이하 또는 관망(현금)" },
} as const;

type Quad = 1 | 2 | 3 | 4;

function quadAt(daily: PredictDailyBar[], i: number): Quad {
  const hv = isHighVolDay(daily.slice(0, i));
  const trend = labelDay(daily[i - 1]).label !== "none";
  return (hv ? (trend ? 3 : 4) : trend ? 1 : 2) as Quad;
}

// 레짐 독립 브리핑 문자 본문 — 실패 시 null (브리핑 크론은 계속)
export async function buildRegimeSms(): Promise<string | null> {
  const kstToday = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const md = kstToday.slice(5).replace("-", "/");
  const blocks: string[] = [];
  const concl: string[] = [];
  for (const [code, name] of [["000660", "하닉"], ["005930", "삼전"]] as const) {
    try {
      const daily = (await fetchDailyPredict(code, 300)).filter((b) => b.date < kstToday);
      if (daily.length < 90) continue;
      const len = daily.length;
      const today = quadAt(daily, len);
      // 오늘 축 수치: vol10 값 + 과거 60일 내 순위, 전일 등락·라벨
      const r10 = daily.slice(-10).reduce((a, b) => a + (b.high - b.low), 0) / 10;
      const vol10 = (r10 / daily[len - 1].close) * 100;
      const prior: number[] = [];
      for (let j = len - 60; j < len; j++) {
        const r = daily.slice(Math.max(0, j - 10), j).reduce((a, b) => a + (b.high - b.low), 0) / 10;
        prior.push((r / daily[j - 1].close) * 100);
      }
      const pctRank = Math.round((100 * prior.filter((v) => v > vol10).length) / prior.length); // 상위 N%
      const prevBar = daily[len - 1];
      const prevL = labelDay(prevBar);
      const prevKo = prevL.label === "leverage" ? "상승 추세일" : prevL.label === "inverse" ? "하락 추세일" : "무추세일";
      // 최근 5일 궤적
      const hist: string[] = [];
      for (let k = 5; k >= 1; k--) hist.push(`Q${quadAt(daily, len - k)}`);
      // 유사 레짐일 실측 (전 구간 재계산 — 살아있는 통계)
      let n = 0, dir = 0, up = 0, dn = 0;
      const rocs: number[] = [];
      for (let i = 80; i < len; i++) {
        if (quadAt(daily, i) !== today) continue;
        n++;
        const l = labelDay(daily[i]);
        if (l.label !== "none") dir++;
        if (l.label === "leverage") up++;
        if (l.label === "inverse") dn++;
        rocs.push(Math.abs(l.rOC));
      }
      rocs.sort((a, b) => a - b);
      const medRoc = rocs.length ? rocs[Math.floor(rocs.length / 2)] : 0;
      const trail = code === "000660" && (today === 3 || today === 4) ? " · 트레일 가동일" : "";
      // 해석 라인 (사용자 지시 2026-07-30 — "데이터가 아니라 데이터를 보고 해석한 인사이트를"):
      // 장기(전 표본) 변동성 백분위로 지금 구간의 의미 + 시스템에 미치는 영향 + 대응을 문장으로.
      // 숫자는 괄호 근거로만. 판정선·스탑이 10일폭에 비례해 자동 확대되는 구조를 명시.
      const longVols: number[] = [];
      for (let j = 90; j < len; j++) {
        const r = daily.slice(Math.max(0, j - 10), j).reduce((a, b) => a + (b.high - b.low), 0) / 10;
        longVols.push((r / daily[j - 1].close) * 100);
      }
      const sorted = [...longVols].sort((a, b) => a - b);
      const medVol = sorted[Math.floor(sorted.length / 2)] ?? vol10;
      const topPct = Math.round((100 * sorted.filter((v) => v > vol10).length) / Math.max(1, sorted.length));
      const mult = medVol > 0 ? vol10 / medVol : 1;
      const facts = `(하루 평균폭 ${vol10.toFixed(1)}% — 1년 중앙 ${medVol.toFixed(1)}%의 ${mult.toFixed(1)}배·상위 ${topPct}%)`;
      const insight = topPct <= 5
        ? `해석: 지금은 1년 중 손꼽히는 초고변동 구간 — 판정선·스탑이 폭에 비례해 자동으로 넓어져 확인은 늦고 컷 한 방은 커집니다. 빠른 신호(F·M) 추격보다 본피셔 확정 위주·비중 절반 이하가 유리한 시기 ${facts}`
        : topPct <= 20
          ? `해석: 고변동 구간 — 판정 문턱과 스탑이 평소보다 넓게 그려지는 중. 왕복 컷 연쇄를 조심할 시기, 분할 진입·확정 위주 ${facts}`
          : topPct >= 80
            ? `해석: 이례적 저변동 — 신호 자체가 드물고 폭이 작은 시기. 나오는 신호의 신뢰는 높지만 무리한 진입은 실익 없음 ${facts}`
            : `해석: 변동성 평시 수준 — 표준 운영 구간 ${facts}`;
      blocks.push(
        `■${name} 오늘 Q${today} ${QUAD[today].name} · 최근5일 ${hist.join("→")}\n` +
        ` 근거: 변동폭 ${vol10.toFixed(1)}%(60일 중 상위 ${pctRank}%) · 전일 ${prevL.rOC >= 0 ? "+" : ""}${prevL.rOC.toFixed(1)}% ${prevKo}\n` +
        ` 유사일 ${n}일 실측: 추세일 ${n ? Math.round((100 * dir) / n) : 0}%(상승 ${up}·하락 ${dn})·|시→종| 중앙 ${medRoc.toFixed(1)}%\n` +
        ` ${QUAD[today].insight}${trail}\n` +
        ` ${insight}`,
      );
      concl.push(`${name} ${QUAD[today].conclude}`);
    } catch { /* 종목 실패 — 건너뜀 */ }
  }
  if (!blocks.length) return null;
  return (
    `[레짐 브리핑 ${md}]\n${blocks.join("\n")}\n` +
    `■결론: ${concl.join(" / ")}. 진입은 장중 확인 문자가 최종 트리거 — 이 결론은 비중 상한 가이드. 무응답=현행 유지`
  );
}
