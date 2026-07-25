// 장중 레짐 4분면 (사용자 지시 2026-07-25 — 아침 브리핑 동봉): 개장 전에 확정되는 두 축으로
// 오늘의 운영 모드를 표기하고 최근 5거래일 궤적을 병기.
//   축1 변동성: vol10(10일 평균폭/전일 종가)이 과거 60거래일 추적 66.7분위 이상 = 고변동
//               (하닉 트레일 반전 가동 기준과 동일 — indicators.isHighVolDay)
//   축2 추세성: 전일 라벨(±1.2% 3분류)이 방향이었나
// 분면별 지침 근거 (레짐 격자 실측, 스펙 2.11): 전일 추세일 = 강세 4/4 (하닉 64%·+40.1 / 삼전
// 67%·+29.3), 무추세 다음날 삼전 49%로 급락. 고변동 구간은 스탑 경제성 열위 (트레일 검증 2.13).

import { fetchDailyPredict } from "./data";
import { isHighVolDay } from "./indicators";
import { labelDay } from "./label";

const QUAD = {
  1: { name: "저변동·전일추세", guide: "표준 운영 (유사일 성과 최상)" },
  2: { name: "저변동·전일무추세", guide: "첫 신호 신중 — 무추세 다음날 적중 저하" },
  3: { name: "고변동·전일추세", guide: "표준 비중·스탑 엄수" },
  4: { name: "고변동·전일무추세", guide: "비중 축소 — 고변동 왕복 위험" },
} as const;

export async function regimeBriefLines(): Promise<string[]> {
  const out: string[] = [];
  const kstToday = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  for (const [code, name] of [["000660", "하닉"], ["005930", "삼전"]] as const) {
    try {
      const daily = (await fetchDailyPredict(code, 170)).filter((b) => b.date < kstToday);
      if (daily.length < 80) continue;
      // i = 그 날의 인덱스 기준 (변동성은 그 전날까지 데이터, 추세성은 전일 라벨)
      const quadAt = (i: number): 1 | 2 | 3 | 4 => {
        const hv = isHighVolDay(daily.slice(0, i));
        const trend = labelDay(daily[i - 1]).label !== "none";
        return (hv ? (trend ? 3 : 4) : trend ? 1 : 2) as 1 | 2 | 3 | 4;
      };
      const today = quadAt(daily.length);
      const hist: string[] = [];
      for (let k = 5; k >= 1; k--) hist.push(`Q${quadAt(daily.length - k)}`);
      const trailNote = code === "000660" && (today === 3 || today === 4) ? "·트레일 가동" : "";
      out.push(`${name} 오늘 Q${today} ${QUAD[today].name} — ${QUAD[today].guide}${trailNote} · 최근5일 ${hist.join("→")}`);
    } catch { /* 종목별 실패는 건너뜀 — 브리핑 발송은 계속 */ }
  }
  if (out.length) out[0] = `[레짐] ${out[0]}`;
  return out;
}
