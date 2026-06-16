// 한국 주식시장 세션 판별 (KST 기준)
// 국내 정규장 09:00~15:30, 시간외 등 + 야간 미국장 시간대까지 고려

export type MarketSession = {
  key: "preopen" | "regular" | "closing" | "afterhours" | "us_overnight" | "closed";
  label: string;
  focus: string; // 세션별 컨설팅 초점
};

// now: KST 시각 (서버는 UTC일 수 있으므로 KST로 변환해 사용)
export function getMarketSession(now: Date = new Date()): MarketSession {
  // KST = UTC+9
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = kst.getUTCDay(); // 0=일,6=토
  const h = kst.getUTCHours();
  const m = kst.getUTCMinutes();
  const t = h * 60 + m; // 분 단위

  const weekend = day === 0 || day === 6;

  // 야간(미국장) — 주중/주말 무관하게 밤 시간대는 미국장 영향권
  // 미국 정규장 대략 22:30~05:00 KST (서머타임에 따라 ±1h)
  if (t >= 22 * 60 + 30 || t < 5 * 60) {
    return {
      key: "us_overnight",
      label: "야간 · 미국장 시간대",
      focus:
        "지금은 미국 정규장 시간대입니다. 오늘 밤 미국 지수·금리·반도체 흐름이 내일 한국장 시초가에 직접 반영됩니다. 한국 종목은 거래 불가 시간이므로, 내일 대응 시나리오를 점검하는 구간입니다.",
    };
  }

  if (weekend) {
    return {
      key: "closed",
      label: "휴장 (주말)",
      focus:
        "주말 휴장입니다. 지난주 마감 데이터 기준이며, 다음 거래일 전략을 미리 정리해두기 좋은 시간입니다.",
    };
  }

  // 평일 한국 시간대
  if (t < 8 * 60 + 30) {
    return {
      key: "closed",
      label: "장 시작 전 (이른 아침)",
      focus:
        "한국장 개장 전입니다. 간밤 미국장 결과가 반영된 시초가를 준비하는 구간입니다.",
    };
  }
  if (t < 9 * 60) {
    return {
      key: "preopen",
      label: "장전 동시호가",
      focus:
        "장전 동시호가 시간(08:30~09:00)입니다. 시초가가 결정되는 구간으로, 간밤 미국장 영향이 큰 갭 출발 가능성을 점검하세요. 추격 주문보다 시초가 확인 후 대응이 안전합니다.",
    };
  }
  if (t < 15 * 60 + 20) {
    return {
      key: "regular",
      label: "정규장",
      focus:
        "정규장(09:00~15:30) 진행 중입니다. 실시간 시세 기준으로 비중·위험선을 점검할 수 있는 구간입니다.",
    };
  }
  if (t < 15 * 60 + 30) {
    return {
      key: "closing",
      label: "장 마감 동시호가",
      focus:
        "장 마감 동시호가(15:20~15:30)입니다. 종가가 결정되는 구간으로, 마감 후 미국장을 고려한 포지션 조정 마지막 기회입니다.",
    };
  }
  if (t < 18 * 60) {
    return {
      key: "afterhours",
      label: "시간외 거래",
      focus:
        "정규장 마감 후 시간외 거래(15:40~18:00) 시간입니다. 거래량이 적어 가격 왜곡이 클 수 있으니 큰 비중 변경은 신중히 접근하세요.",
    };
  }
  return {
    key: "closed",
    label: "장 마감 후",
    focus:
      "한국장 마감 후입니다. 오늘 결과를 정리하고, 오늘 밤 미국장 일정을 점검하기 좋은 시간입니다.",
  };
}
