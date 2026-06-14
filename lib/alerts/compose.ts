import type { AlertTrigger, PositionForAlert } from "./triggers";

export type AlertMessage = {
  subject: string;
  action: string;
  prohibition: string;
  reasons: string[];
  nonCompliance: {
    cause: string;
    vulnerableTicker: string;
    lossOutcome: string;
    indicatorsToCheck: string;
  };
  buffett: string;
};

export type PrincipleForAlert = {
  principle_key: string;
  is_on: boolean;
};

const TRIGGER_LABELS: Record<
  string,
  { action: string; prohibition: string; buffett: string }
> = {
  low: {
    action: "레버리지 비중 축소 원칙 재확인",
    prohibition: "전저점 이탈 구간에서 추가 매수 자제",
    buffett: "전저점 이탈은 추세 전환의 초기 신호일 수 있습니다. 생존 가능한 현금 여력이 먼저입니다.",
  },
  drop5: {
    action: "레버리지 포지션 비중 축소 검토",
    prohibition: "손실 만회성 추가 매수 금지",
    buffett: "단기 급락을 맞히려는 레버리지보다 생존 가능한 현금 여력이 우선입니다.",
  },
  futures: {
    action: "나스닥 선물 방향 재확인 후 대응 보류",
    prohibition: "선물 약세 + 금리 상승 구간 신규 진입 금지",
    buffett: "금리 상승과 나스닥 동반 약세는 기술주·레버리지 ETF에 복합 압력을 가합니다. 확인 전 대기를 고려해볼 수 있습니다.",
  },
  rebound: {
    action: "반등의 지속성을 선물 방향·수급으로 먼저 확인",
    prohibition: "반도체 지수 미회복 상태에서 추격 매수 자제",
    buffett: "반등이 나와도 반도체 지수가 따라오지 않는다면 단기 반등일 가능성이 있습니다. 수급 확인 후 판단을 권합니다.",
  },
};

const PRINCIPLE_MAPPING: Record<string, string[]> = {
  low: ["lev", "avg"],
  drop5: ["lev", "loan"],
  futures: ["lev", "gap"],
  rebound: ["avg"],
};

function getLeverageTickers(positions: PositionForAlert[]): string {
  const tickers = positions.filter((p) => p.is_leverage).map((p) => p.ticker);
  return tickers.length > 0 ? tickers.join(", ") : "레버리지 포지션";
}

const NON_COMPLIANCE_TEMPLATES: Record<
  string,
  (vulTicker: string) => AlertMessage["nonCompliance"]
> = {
  low: (t) => ({
    cause: "시장 전저점 이탈 + 추세 전환 가능성",
    vulnerableTicker: t,
    lossOutcome: "레버리지 ETF 하락을 2~3배 확대 반영, 빠른 손실 확대 가능",
    indicatorsToCheck: "코스피 지지선 · 나스닥 선물 방향 · 외국인 수급",
  }),
  drop5: (t) => ({
    cause: "나스닥/반도체 지수 장중 급락",
    vulnerableTicker: t,
    lossOutcome: "레버리지 포지션 급락 배수 손실 · 반등 없이 추가 하락 가능",
    indicatorsToCheck: "나스닥 선물 · 미국 10년물 금리 · 반도체 섹터 수급",
  }),
  futures: (t) => ({
    cause: "나스닥 선물 약세 + 금리 상승 동시 발생",
    vulnerableTicker: t,
    lossOutcome: "기술주·레버리지 ETF 복합 압력 — 갭하락 위험 증가",
    indicatorsToCheck: "나스닥 선물 · 미국 10년물 금리 · 달러/원 환율",
  }),
  rebound: (t) => ({
    cause: "나스닥 반등에도 반도체 지수 미회복 — 반등 실패 가능성",
    vulnerableTicker: t,
    lossOutcome: "반등 추격 매수 후 재하락 시 고점 매수 손실",
    indicatorsToCheck: "SOX 지수 방향 · 나스닥 선물 · 외국인 수급",
  }),
};

export function composeAlertMessage(
  trigger: AlertTrigger,
  positions: PositionForAlert[],
  principles: PrincipleForAlert[],
  stage: string
): AlertMessage {
  const labels = TRIGGER_LABELS[trigger.trigger_key] ?? {
    action: "현재 포지션 점검",
    prohibition: "충동적 매매 자제",
    buffett: "원칙을 지키는 것이 최선입니다.",
  };

  // 활성 원칙 중 이 trigger_key와 관련된 원칙 추가
  const relatedPrinciples = (PRINCIPLE_MAPPING[trigger.trigger_key] ?? [])
    .filter((key) => principles.find((p) => p.principle_key === key && p.is_on))
    .map((key) => {
      const map: Record<string, string> = {
        lev: "레버리지 신규 매수 금지 원칙 활성",
        avg: "급락 첫날 물타기 금지 원칙 활성",
        loan: "손실 만회 대출 매수 금지 원칙 활성",
        gap: "갭하락 위험 확인 원칙 활성",
      };
      return map[key] ?? key;
    });

  const action = relatedPrinciples.length > 0
    ? `${labels.action} (${relatedPrinciples.join(", ")})`
    : labels.action;

  const vulnerableTicker = getLeverageTickers(positions);
  const nonCompliance = (
    NON_COMPLIANCE_TEMPLATES[trigger.trigger_key] ?? NON_COMPLIANCE_TEMPLATES.drop5
  )(vulnerableTicker);

  const severityLabel = trigger.severity === "high" ? "[우선 강도 높음]" : "";

  return {
    subject: `${severityLabel} 스탁가드 장중 알림 — ${trigger.reason}`,
    action,
    prohibition: labels.prohibition,
    reasons: [trigger.reason, `현재 장세: ${stage}`],
    nonCompliance,
    buffett: labels.buffett,
  };
}

export function alertMessageToText(msg: AlertMessage): string {
  return [
    `[행동] ${msg.action}`,
    `[금지] ${msg.prohibition}`,
    `[이유]`,
    ...msg.reasons.map((r) => `  · ${r}`),
    ``,
    `[무시하면 생길 수 있는 리스크]`,
    `  1. 원인: ${msg.nonCompliance.cause}`,
    `  2. 취약 종목: ${msg.nonCompliance.vulnerableTicker}`,
    `  3. 손실 결과: ${msg.nonCompliance.lossOutcome}`,
    `  4. 확인할 지표: ${msg.nonCompliance.indicatorsToCheck}`,
    ``,
    `[버핏식 원칙 관점]`,
    `  ${msg.buffett}`,
    ``,
    `─────────────────────────`,
    `본 알림은 투자 권유·매매 지시가 아니며 최종 판단과 책임은 본인에게 있습니다.`,
  ].join("\n");
}
