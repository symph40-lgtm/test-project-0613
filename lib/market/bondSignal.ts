// 채권·금리 기반 '반도체 매도 시그널' — 실데이터(FRED)로 트리거를 직접 판정한다.
// AI 텍스트 의견이 아니라 실제 금리/스프레드 숫자에 임계값을 적용해 켜짐/꺼짐을 매긴다.
// 트리거 출처: 사용자 Q&A의 매도-경보 프레임(수익률곡선·절대금리·크레딧 스프레드·베어 스티프닝).

import YahooFinance from "yahoo-finance2";
import { type Stance7, scoreToStance7, STANCE7_META } from "./stance";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

// 실시간 미 10년물 금리(^TNX) — FRED DGS10은 1~2영업일 지연돼 절대 레벨엔 부적합.
async function liveTnx(): Promise<number | null> {
  try {
    const q = await yf.quote("^TNX");
    const p = q.regularMarketPrice;
    return typeof p === "number" && p > 0 && p < 20 ? p : null;
  } catch {
    return null;
  }
}

export type TriggerStatus = "on" | "watch" | "off";

export type BondTrigger = {
  key: string;
  label: string;
  status: TriggerStatus; // on=매도신호 발동, watch=경계, off=비발동
  value: string;         // 실제 값 표기
  detail: string;        // 해석
  weight: number;        // 점수 기여(음수=매도압력)
};

export type BondSignal = {
  asOf: string;
  rates: {
    y2: number | null; y10: number | null; y30: number | null;
    spread10_2: number | null; hyOasBp: number | null;
    d10: number | null; // 10년물 최근 변화(%p)
    d2: number | null;  // 2년물 최근 변화(%p)
  };
  triggers: BondTrigger[];
  score: number;       // 합산(음수=매도압력 누적)
  stance: Stance7;     // 7단계
  stanceLabel: string;
  summary: string;
};

type Obs = { date: string; value: number };

async function fredSeries(id: string, limit = 8): Promise<Obs[]> {
  const key = process.env.FRED_API_KEY;
  if (!key) return [];
  try {
    const url =
      `https://api.stlouisfed.org/fred/series/observations?series_id=${id}` +
      `&api_key=${key}&file_type=json&sort_order=desc&limit=${limit}`;
    const res = await fetch(url, { next: { revalidate: 3600 } });
    if (!res.ok) return [];
    const j = (await res.json()) as { observations?: { date: string; value: string }[] };
    return (j.observations ?? [])
      .filter((o) => o.value !== ".")
      .map((o) => ({ date: o.date, value: parseFloat(o.value) }))
      .filter((o) => !isNaN(o.value));
  } catch {
    return [];
  }
}

const latest = (o: Obs[]) => (o.length ? o[0].value : null);
// 최근 변화(%p): 최신 - 5영업일 전(없으면 직전)
function change(o: Obs[]): number | null {
  if (o.length < 2) return null;
  const prev = o[Math.min(5, o.length - 1)].value;
  return Number((o[0].value - prev).toFixed(2));
}

export async function fetchBondSignal(): Promise<BondSignal | null> {
  if (!process.env.FRED_API_KEY) return null;
  const [s2, s10, s30, spr, hy, tnx] = await Promise.all([
    fredSeries("DGS2"),
    fredSeries("DGS10"),
    fredSeries("DGS30"),
    fredSeries("T10Y2Y"),
    fredSeries("BAMLH0A0HYM2"),
    liveTnx(),
  ]);

  const y2 = latest(s2), y30 = latest(s30);
  // 10년물 절대 레벨은 실시간 ^TNX 우선(FRED는 지연) — 변화·곡선 분석은 FRED 시계열 유지
  const y10 = tnx ?? latest(s10);
  const spread10_2 = latest(spr);
  const hyOas = latest(hy);
  const hyOasBp = hyOas !== null ? Math.round(hyOas * 100) : null;
  const d10 = change(s10), d2 = change(s2), d30 = change(s30);

  if (y10 === null && spread10_2 === null && hyOasBp === null) return null;

  const triggers: BondTrigger[] = [];
  let score = 0;
  const add = (t: BondTrigger) => { triggers.push(t); score += t.weight; };

  // 1) 절대 금리 레벨 (미 10년물)
  if (y10 !== null) {
    let status: TriggerStatus = "off", weight = 0, detail = "";
    if (y10 >= 5.5) { status = "on"; weight = -3; detail = "역사적 위험 구간"; }
    else if (y10 >= 5.0) { status = "on"; weight = -2; detail = "강한 매도 시그널 구간(5% 돌파)"; }
    else if (y10 >= 4.5) { status = "watch"; weight = -1; detail = "고PER 압박 주의 구간"; }
    else if (y10 >= 4.0) { status = "off"; weight = 0; detail = "중립 구간"; }
    else { status = "off"; weight = 1; detail = "성장주 우호(4% 이하)"; }
    add({ key: "level", label: "미 10년물 절대 금리", status, value: `${y10.toFixed(2)}%`, detail, weight });
  }

  // 2) 수익률 곡선 (10Y-2Y)
  if (spread10_2 !== null) {
    let status: TriggerStatus = "off", weight = 0, detail = "";
    if (spread10_2 < 0) { status = "on"; weight = -1; detail = "역전 — 경기침체 선행 신호"; }
    else if (spread10_2 < 0.3) { status = "watch"; weight = 0; detail = "역전 해소 직후 — 침체 본격화 경계 구간"; }
    else { status = "off"; weight = 0; detail = "정상 우상향"; }
    add({ key: "curve", label: "수익률 곡선(10Y-2Y)", status, value: `${spread10_2 > 0 ? "+" : ""}${spread10_2.toFixed(2)}%p`, detail, weight });
  }

  // 3) 베어 스티프닝 (장기금리가 단기보다 빠르게 상승)
  if (d10 !== null && d2 !== null) {
    const steepen = (d30 ?? d10) - d2; // 장기 변화 - 단기 변화
    const bear = d10 > 0.05 && steepen > 0.05;
    add({
      key: "steepen", label: "베어 스티프닝(장기금리 급등)",
      status: bear ? "on" : "off", weight: bear ? -1 : 0,
      value: `Δ10Y ${d10 > 0 ? "+" : ""}${d10}%p · Δ2Y ${d2 > 0 ? "+" : ""}${d2}%p`,
      detail: bear ? "장기금리가 단기보다 빠르게 급등 — 성장주 할인율 직격" : "해당 패턴 아님",
    });
  }

  // 4) 하이일드 크레딧 스프레드
  if (hyOasBp !== null) {
    let status: TriggerStatus = "off", weight = 0, detail = "";
    if (hyOasBp >= 400) { status = "on"; weight = -2; detail = "신용경색 — 강한 위험 신호"; }
    else if (hyOasBp >= 300) { status = "watch"; weight = -1; detail = "주의 — 스프레드 확대 조짐"; }
    else { status = "off"; weight = 1; detail = "안정(리스크온) — 반도체 우호"; }
    add({ key: "hy", label: "하이일드 크레딧 스프레드", status, value: `${hyOasBp}bp`, detail, weight });
  }

  const stance = scoreToStance7(score);
  const onCount = triggers.filter((t) => t.status === "on").length;
  const watchCount = triggers.filter((t) => t.status === "watch").length;
  const summary =
    onCount > 0
      ? `매도 트리거 ${onCount}개 발동${watchCount ? ` · 경계 ${watchCount}개` : ""} — 채권·금리發 반도체 하방 압력`
      : watchCount > 0
        ? `발동 트리거 없음 · 경계 ${watchCount}개 — 트리거 미발현, 관망 구간`
        : "매도 트리거 모두 비발동 — 채권·금리상 반도체에 우호/중립";

  return {
    asOf: new Date().toISOString(),
    rates: { y2, y10, y30, spread10_2, hyOasBp, d10, d2 },
    triggers, score, stance, stanceLabel: STANCE7_META[stance].label, summary,
  };
}
