// 종목별 매매 점수 엔진 — 실전 애널리스트 체크리스트를 실데이터로 채점한다.
// 핵심: 종목의 '섹터'를 분류해, 현재 국면에서 무엇에 중점을 둘지 동적으로 가중한다.
//  · 성장주(반도체·빅테크·2차전지·바이오) → 금리·물가·달러 매크로 + 업황(SOX) 무겁게
//  · 금융 → 금리(NIM 우호)·PBR·ROE·배당  · 수출주(자동차·조선) → 환율(약원화 우호)
// 채점 항목: 실적/EPS리비전(1순위)·업황·밸류에이션·수익성·재무안정·수급·기술·매크로·주주환원.
import YahooFinance from "yahoo-finance2";
import { type Stance7, STANCE7_META } from "./stance";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

export type ScoreFactor = {
  label: string;
  signal: "buy" | "neutral" | "sell";
  pts: number;
  detail: string;
};

export type HoldingScore = {
  ticker: string;
  stance: Stance7;
  tone: "buy" | "hold" | "sell";
  label: string;
  score: number;
  factors: ScoreFactor[];
  reason: string;
  sectorCat: string;   // 분류된 섹터
  focus: string;       // 이 섹터에서 현재 중점 둘 항목
  dataCount: number;
};

// ── 섹터 분류 ──────────────────────────────────────────────
export type SectorCat =
  | "반도체" | "빅테크·IT" | "2차전지" | "바이오" | "자동차"
  | "금융" | "조선" | "화학·정유" | "통신" | "방산" | "건설" | "ETF·기타";

function classifySector(ticker: string, sector: string | null): SectorCat {
  const s = `${ticker} ${sector ?? ""}`.toLowerCase();
  const has = (...k: string[]) => k.some((x) => s.includes(x));
  if (has("반도체", "하이닉스", "hynix", "micron", "마이크론", "sandisk", "샌디스크", "western digital", "seagate", "삼성전자", "samsung elec", "sk스퀘어", "sk square", "sksquare", "semiconductor", "hbm", "tsmc", "soxl", "필라델피아")) return "반도체";
  if (has("qqq", "nasdaq", "나스닥", "apple", "microsoft", "마이크로소프트", "google", "alphabet", "amazon", "meta", "palantir", "팔란티어", "it leverage", "소프트웨어", "ai ", " ai", "tiger 200 it", "인터넷")) return "빅테크·IT";
  if (has("2차전지", "배터리", "battery", "에코프로", "lg에너지", "lg에너지솔루션", "삼성sdi", "sdi", "엘앤에프", "포스코퓨처엠")) return "2차전지";
  if (has("바이오", "제약", "pharma", "bio", "셀트리온", "삼성바이오", "헬스", "health")) return "바이오";
  if (has("자동차", "현대차", "기아", "모비스", "auto", "ev ", "전기차")) return "자동차";
  if (has("은행", "금융", "증권", "보험", "bank", "생명", "화재", "kb", "신한", "하나금융", "우리금융", "메리츠", "samsung life", "삼성생명", "지주")) return "금융";
  if (has("조선", "중공업", "ship", "한화오션", "hd현대", "hd한국조선")) return "조선";
  if (has("화학", "정유", "에너지화학", "chem", "롯데케미", "sk이노", "정밀화학")) return "화학·정유";
  if (has("통신", "telecom", "kt", "skt", "sk텔레콤", "유플러스", "lg유플러스")) return "통신";
  if (has("방산", "에어로", "aero", "defense", "넥스원", "현대로템", "한화시스템")) return "방산";
  if (has("건설", "construction", "현대건설", "gs건설", "대우건설")) return "건설";
  if (has("kodex", "tiger", "rise", "plus", "sol ", "arirang", "etf", "esg", "sri", "200")) return "ETF·기타";
  return "ETF·기타";
}

// 섹터별 '현재 중점 항목' 안내 + 매크로 민감도(성장주=금리부담, 금융=금리우호, 수출주=약원화우호)
type SectorProfile = {
  focus: string;
  growth: boolean;       // 금리 상승 = 할인율↑ 부담 (성장주)
  rateBenefit: boolean;  // 금리 상승 = NIM 우호 (금융)
  exporter: boolean;     // 약원화(달러강세) = 수출 우호
  oilBenefit: boolean;   // 유가 상승 수혜(정유)
  semis: boolean;        // 반도체 업황(SOX) 직접 연동
  valueBook: boolean;    // PBR·배당 중심(금융·통신)
};
const SECTOR_PROFILE: Record<SectorCat, SectorProfile> = {
  "반도체":   { focus: "금리·물가·달러 + SOX/HBM 수요·외국인 수급·DRAM 가격·빅테크 캡엑스", growth: true, rateBenefit: false, exporter: true, oilBenefit: false, semis: true, valueBook: false },
  "빅테크·IT": { focus: "미국 10년물 금리·AI 캡엑스/데이터센터 수익·나스닥 모멘텀·달러", growth: true, rateBenefit: false, exporter: false, oilBenefit: false, semis: false, valueBook: false },
  "2차전지":  { focus: "금리·EV 판매·배터리 메탈 가격·정책(IRA)·실적 턴어라운드", growth: true, rateBenefit: false, exporter: true, oilBenefit: false, semis: false, valueBook: false },
  "바이오":   { focus: "금리·임상/파이프라인·현금소진·기술수출", growth: true, rateBenefit: false, exporter: false, oilBenefit: false, semis: false, valueBook: false },
  "자동차":   { focus: "환율(약원화 우호)·글로벌 판매·관세·EV 전환", growth: false, rateBenefit: false, exporter: true, oilBenefit: false, semis: false, valueBook: false },
  "금융":     { focus: "금리(NIM)·PBR·ROE·연체율·배당/자사주", growth: false, rateBenefit: true, exporter: false, oilBenefit: false, semis: false, valueBook: true },
  "조선":     { focus: "수주잔고·선가·환율·후판 가격", growth: false, rateBenefit: false, exporter: true, oilBenefit: false, semis: false, valueBook: false },
  "화학·정유": { focus: "정제마진·유가·중국 수요·스프레드", growth: false, rateBenefit: false, exporter: true, oilBenefit: true, semis: false, valueBook: false },
  "통신":     { focus: "ARPU·배당수익률·CAPEX·규제", growth: false, rateBenefit: false, exporter: false, oilBenefit: false, semis: false, valueBook: true },
  "방산":     { focus: "수주·지정학 리스크·수출 모멘텀", growth: false, rateBenefit: false, exporter: true, oilBenefit: false, semis: false, valueBook: false },
  "건설":     { focus: "금리·분양·미분양·해외수주", growth: false, rateBenefit: false, exporter: false, oilBenefit: false, semis: false, valueBook: true },
  "ETF·기타":  { focus: "지수·섹터 모멘텀·금리·수급(펀더멘털 데이터 제한적)", growth: true, rateBenefit: false, exporter: false, oilBenefit: false, semis: false, valueBook: false },
};

// ── 기술적 지표 ────────────────────────────────────────────
function sma(a: number[], n: number): number | null {
  if (a.length < n) return null;
  return a.slice(-n).reduce((s, x) => s + x, 0) / n;
}
function rsi14(closes: number[]): number | null {
  if (closes.length < 15) return null;
  let g = 0, l = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  const ag = g / 14, al = l / 14;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}
type Tech = { ma50: number | null; ma200: number | null; pos52: number | null; rsi: number | null; trend1m: number | null; aligned: "정배열" | "역배열" | "혼조" | null };
async function technicals(symbol: string): Promise<Tech | null> {
  try {
    const c = await yf.chart(symbol, { period1: new Date(Date.now() - 300 * 24 * 3600 * 1000), interval: "1d" });
    const closes = (c.quotes ?? []).filter((x): x is typeof x & { close: number } => x.close != null).map((r) => r.close);
    if (closes.length < 50) return null;
    const last = closes[closes.length - 1];
    const ma50 = sma(closes, 50), ma200 = sma(closes, 200);
    const win = closes.slice(-252), hi = Math.max(...win), lo = Math.min(...win);
    const pos52 = hi > lo ? ((last - lo) / (hi - lo)) * 100 : null;
    const trend1m = closes.length > 22 ? (last / closes[closes.length - 22] - 1) * 100 : null;
    const aligned: Tech["aligned"] = ma50 !== null && ma200 !== null
      ? last > ma50 && ma50 > ma200 ? "정배열" : last < ma50 && ma50 < ma200 ? "역배열" : "혼조"
      : null;
    return { ma50, ma200, pos52, rsi: rsi14(closes), trend1m, aligned };
  } catch { return null; }
}

// ── 펀더멘털(확장) ─────────────────────────────────────────
type Fund = {
  recMean: number | null; analysts: number | null; vsTargetPct: number | null;
  forwardPE: number | null; peg: number | null; pbr: number | null;
  roe: number | null; opMargin: number | null;
  revenueGrowth: number | null; earningsGrowth: number | null;
  debtToEquity: number | null; dividendYield: number | null;
  epsRevision: number | null; // +1y EPS 추정치 90일 변화율(%)
};
async function fundamentals(symbol: string): Promise<Fund | null> {
  const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);
  const pick = (o: unknown, ...keys: string[]): unknown =>
    keys.reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), o);
  try {
    const r = (await yf.quoteSummary(symbol, {
      modules: ["financialData", "defaultKeyStatistics", "summaryDetail", "earningsTrend"],
    })) as Record<string, unknown>;
    const fd = (r.financialData ?? {}) as Record<string, unknown>;
    const ks = (r.defaultKeyStatistics ?? {}) as Record<string, unknown>;
    const sd = (r.summaryDetail ?? {}) as Record<string, unknown>;
    const trend = (pick(r, "earningsTrend", "trend") ?? []) as Array<Record<string, unknown>>;
    const ty = trend.find((t) => t.period === "+1y") ?? trend[0];
    const eps = (ty?.epsTrend ?? {}) as Record<string, unknown>;
    const cur90 = num(eps.current), d90 = num(eps["90daysAgo"]);
    const target = num(fd.targetMeanPrice), price = num(fd.currentPrice);
    return {
      recMean: num(fd.recommendationMean), analysts: num(fd.numberOfAnalystOpinions),
      vsTargetPct: target && price ? ((price - target) / target) * 100 : null,
      forwardPE: num(sd.forwardPE), peg: num(ks.pegRatio), pbr: num(ks.priceToBook),
      roe: num(fd.returnOnEquity), opMargin: num(fd.operatingMargins),
      revenueGrowth: num(fd.revenueGrowth), earningsGrowth: num(fd.earningsGrowth),
      debtToEquity: num(fd.debtToEquity), dividendYield: num(sd.dividendYield),
      epsRevision: cur90 !== null && d90 !== null && d90 !== 0 ? ((cur90 - d90) / Math.abs(d90)) * 100 : null,
    };
  } catch { return null; }
}

export type ScoreInput = {
  ticker: string;
  symbol: string | null;
  isLeverage: boolean;
  sector: string | null;
  changePercent?: number | null;
  // 당일 시장 최악 신호 (코스피·코스피선물·나스닥선물·보유평균 중 최저 %) — 급락일 감지·스탠스 상한
  marketDropPct?: number | null;
  composite: number;
  soxChange: number | null;
  macro?: {
    rateChgPct: number | null;   // 미 10년물 당일 변화 %
    oilChgPct: number | null;    // 유가 당일 %
    dollarChgPct: number | null; // 달러지수 당일 %
  };
  aiBias?: number;
  aiReason?: string | null;
};

function scoreToStance(s: number): Stance7 {
  if (s >= 68) return 10;
  if (s >= 54) return 9;
  if (s >= 40) return 8;
  if (s >= 26) return 7;
  if (s >= 12) return 6;
  if (s >= -2) return 5;
  if (s >= -16) return 4;
  if (s >= -30) return 3;
  if (s >= -44) return 2;
  return 1;
}

export async function scoreHolding(input: ScoreInput): Promise<HoldingScore> {
  const cat = classifySector(input.ticker, input.sector);
  const prof = SECTOR_PROFILE[cat];
  const sym = input.symbol;
  const [fund, tech] = await Promise.all([
    sym ? fundamentals(sym) : Promise.resolve(null),
    sym ? technicals(sym) : Promise.resolve(null),
  ]);

  const factors: ScoreFactor[] = [];
  let score = 0;
  const add = (label: string, pts: number, detail: string) => {
    if (pts === 0 && !detail) return;
    factors.push({ label, pts, signal: pts > 0 ? "buy" : pts < 0 ? "sell" : "neutral", detail });
    score += pts;
  };

  // ── 급락일 감지 (2026-07-13 사용자 피드백: 하닉 -16% 폭락일에 '중립(매수우위)' 오판 수정)
  // 원인: 당일 감점 상한 -6 + 장세 -8 = -14뿐이라 펀더멘털 가점(+50~70)이 항상 압도.
  // 목표주가·컨센서스는 급락을 아직 반영 못 한 낡은 앵커라 급락일엔 절반만 반영하고,
  // 최종 스탠스에 상한(캡)을 둔다 — 펀더멘털이 아무리 좋아도 급락일에 '비중 확대'는 못 나온다.
  const dayChg = input.changePercent ?? null;
  const mDrop = input.marketDropPct ?? null;
  const crisis = (dayChg !== null && dayChg <= -5) || (mDrop !== null && mDrop <= -4);
  const severeCrisis = (dayChg !== null && dayChg <= -8) || (mDrop !== null && mDrop <= -6);
  const staleAnchor = (pts: number) => (crisis && pts > 0 ? Math.round(pts / 2) : pts);

  // ① 실적 — EPS 추정치 변화(1순위, 가장 강한 신호)
  if (fund?.epsRevision != null) {
    const e = fund.epsRevision;
    const pts = e >= 5 ? 16 : e >= 1 ? 9 : e >= -1 ? 0 : e >= -5 ? -9 : -16;
    add("EPS 추정 변화", pts, `90일 ${e >= 0 ? "+" : ""}${e.toFixed(1)}%`);
  }
  // ① 성장 — 매출·이익 성장률
  if (fund?.earningsGrowth != null) {
    const g = fund.earningsGrowth * 100;
    const pts = g >= 20 ? 8 : g >= 5 ? 4 : g >= -5 ? 0 : -6;
    add("이익 성장", pts, `${g >= 0 ? "+" : ""}${g.toFixed(0)}%`);
  } else if (fund?.revenueGrowth != null) {
    const g = fund.revenueGrowth * 100;
    const pts = g >= 10 ? 6 : g >= 3 ? 3 : g >= -3 ? 0 : -5;
    add("매출 성장", pts, `${g >= 0 ? "+" : ""}${g.toFixed(0)}%`);
  }
  // ② 업황 — 반도체 SOX(반도체 종목에 가중)
  if (prof.semis && input.soxChange != null) {
    const s = input.soxChange;
    add("반도체 업황(SOX)", s > 1.5 ? 8 : s > 0.3 ? 3 : s < -1.5 ? -8 : s < -0.3 ? -3 : 0, `SOX ${s >= 0 ? "+" : ""}${s.toFixed(1)}%`);
  }
  // ③ 밸류에이션 — 금융·통신은 PBR, 그 외 PEG/PER
  if (prof.valueBook && fund?.pbr != null && fund.pbr > 0) {
    const pb = fund.pbr;
    add("밸류(PBR)", pb < 0.8 ? 8 : pb < 1.2 ? 4 : pb < 2 ? 0 : -5, `PBR ${pb.toFixed(2)}`);
  } else if (fund?.peg != null && fund.peg > 0) {
    add("밸류(PEG)", fund.peg < 1 ? 10 : fund.peg < 1.5 ? 5 : fund.peg < 2.5 ? 0 : -8, `PEG ${fund.peg.toFixed(2)}`);
  } else if (fund?.forwardPE != null && fund.forwardPE > 0) {
    const pe = fund.forwardPE;
    add("밸류(선행PER)", pe < 12 ? 6 : pe < 20 ? 2 : pe < 35 ? 0 : pe < 50 ? -5 : -10, `선행PER ${pe.toFixed(1)}`);
  }
  // ④ 수익성 — ROE
  if (fund?.roe != null) {
    add("수익성(ROE)", fund.roe > 0.25 ? 8 : fund.roe > 0.12 ? 4 : fund.roe > 0.03 ? 0 : -6, `ROE ${(fund.roe * 100).toFixed(0)}%`);
  }
  // ⑤ 재무 안정성 — 부채비율
  if (fund?.debtToEquity != null) {
    const d = fund.debtToEquity; // Yahoo는 % 단위(예: 50 = 0.5배)
    add("재무(부채비율)", d < 50 ? 4 : d < 120 ? 0 : d < 200 ? -3 : -6, `D/E ${d.toFixed(0)}%`);
  }
  // ⑥ 컨센서스(한국은 변별력 낮아 가중 작게) — 급락일엔 낡은 앵커라 가점 절반
  if (fund?.recMean != null) {
    const r = fund.recMean;
    const pts = staleAnchor(r <= 1.5 ? 8 : r <= 2.0 ? 4 : r <= 2.7 ? 1 : r <= 3.3 ? -4 : -10);
    add("컨센서스", pts, `등급 ${r.toFixed(1)}/5${crisis && pts > 0 ? " (급락일 ½)" : ""}`);
  }
  if (fund?.vsTargetPct != null && Math.abs(fund.vsTargetPct) < 55) {
    const v = fund.vsTargetPct;
    // 급락일의 '목표가 하단' 가점은 역설(떨어질수록 가점↑) — 절반만 반영
    const pts = staleAnchor(v <= -20 ? 10 : v <= -8 ? 6 : v <= -3 ? 3 : v >= 15 ? -8 : v >= 5 ? -3 : 0);
    add("목표주가 여력", pts, `${v <= 0 ? `목표가 ${(-v).toFixed(0)}% 하단` : `목표가 ${v.toFixed(0)}% 상회`}${crisis && pts > 0 ? " (급락일 ½)" : ""}`);
  }
  // ⑦ 기술적 추세
  if (tech?.aligned) add("추세(이평)", tech.aligned === "정배열" ? 9 : tech.aligned === "역배열" ? -9 : 0, tech.aligned);
  if (tech?.rsi != null) { const r = tech.rsi; add("RSI", r < 30 ? 6 : r < 40 ? 3 : r > 78 ? -8 : r > 70 ? -4 : 0, `${r.toFixed(0)}`); }
  if (tech?.pos52 != null) { const p = tech.pos52; add("52주 위치", p >= 92 ? -5 : p >= 70 ? 4 : p <= 15 ? -4 : 0, `${p.toFixed(0)}%`); }
  if (tech?.trend1m != null) { const t = tech.trend1m; add("1개월 모멘텀", t > 10 ? 5 : t > 3 ? 2 : t < -10 ? -5 : t < -3 ? -2 : 0, `${t >= 0 ? "+" : ""}${t.toFixed(1)}%`); }
  // 주주환원 — 배당
  if (fund?.dividendYield != null && fund.dividendYield > 0) {
    const y = fund.dividendYield * 100;
    add("배당", y >= 4 ? 4 : y >= 2 ? 2 : 0, `${y.toFixed(1)}%`);
  }

  // ⑨ 매크로 — 섹터 민감도에 맞춰(성장주=금리부담, 금융=금리우호, 수출주=달러강세 우호)
  const m = input.macro;
  if (m) {
    if (m.rateChgPct != null) {
      const rc = m.rateChgPct;
      let pts = 0, why = "";
      if (prof.rateBenefit) { pts = rc > 1 ? 5 : rc > 0.3 ? 2 : rc < -1 ? -3 : 0; why = "금리↑=NIM 우호"; }
      else if (prof.growth) { pts = rc > 1.5 ? -7 : rc > 0.5 ? -3 : rc < -1.5 ? 4 : rc < -0.5 ? 2 : 0; why = "성장주=금리 부담"; }
      else { pts = rc > 1.5 ? -3 : rc < -1.5 ? 2 : 0; why = "금리 민감"; }
      if (pts !== 0) add("금리(매크로)", pts, `10Y ${rc >= 0 ? "+" : ""}${rc.toFixed(1)}% · ${why}`);
    }
    if (m.oilChgPct != null) {
      const oc = m.oilChgPct;
      let pts = 0;
      if (prof.oilBenefit) pts = oc > 3 ? 4 : oc < -3 ? -3 : 0;            // 정유=유가↑ 수혜
      else if (prof.growth) pts = oc > 4 ? -4 : oc > 2 ? -2 : oc < -3 ? 2 : 0; // 성장주=유가↑(인플레) 부담
      if (pts !== 0) add("유가(매크로)", pts, `WTI ${oc >= 0 ? "+" : ""}${oc.toFixed(1)}%`);
    }
    if (m.dollarChgPct != null && (prof.exporter || prof.growth)) {
      const dc = m.dollarChgPct;
      // 한국 수출주는 약원화(달러강세) 소폭 우호, 단 외국인 이탈 양면 → 작게
      const pts = prof.exporter ? (dc > 0.8 ? 2 : dc < -0.8 ? -1 : 0) : 0;
      if (pts !== 0) add("달러(매크로)", pts, `DXY ${dc >= 0 ? "+" : ""}${dc.toFixed(1)}%`);
    }
  }

  // ⑩ 장세(종합 리스크) — 상단 세분화 (2026-07-13: 리스크 100에 -8은 과소)
  const c = input.composite;
  add("장세(종합리스크)", c <= 12 ? 6 : c <= 22 ? 3 : c <= 35 ? 0 : c <= 50 ? -4 : c <= 65 ? -8 : c <= 80 ? -11 : -15, `리스크 ${c}/100`);
  // 당일 급등락 — 사다리 확대 (2026-07-13: 기존 상한 -6은 -16% 폭락도 -6점이라 무력)
  if (dayChg != null) {
    const pts = dayChg <= -12 ? -24 : dayChg <= -8 ? -18 : dayChg <= -5 ? -12 : dayChg <= -3 ? -7 : dayChg <= -1.5 ? -3 : dayChg >= 9 ? -3 : 0;
    if (pts !== 0) add("당일 등락", pts, `${dayChg >= 0 ? "+" : ""}${dayChg.toFixed(1)}%`);
  }
  // 당일 시장 급락 (코스피·선물·나스닥선물·보유평균 중 최악) — 종목이 안 빠져도 시장이 무너지면 감점
  if (mDrop != null && mDrop <= -1.5) {
    add("시장 급락", mDrop <= -6 ? -12 : mDrop <= -4 ? -8 : mDrop <= -2.5 ? -4 : -2, `시장 최악 ${mDrop.toFixed(1)}%`);
  }
  // 레버리지 변동성
  if (input.isLeverage) add("레버리지", score < 0 ? -8 : -4, "변동성↑");
  // AI 의견(±2 한정)
  if (input.aiBias) {
    const b = Math.max(-2, Math.min(2, Math.round(input.aiBias)));
    if (b !== 0) add("AI 의견", b * 4, input.aiReason ? String(input.aiReason).slice(0, 30) : `${b > 0 ? "+" : ""}${b}`);
  }

  // 급락일 스탠스 상한 (2026-07-13) — 점수와 무관한 최종 안전장치.
  // 종목 -5% 또는 시장 -4% 급락일: 최대 5(중립·매도우위) / 종목 -8% 또는 시장 -6%: 최대 4(비중축소).
  let stance = scoreToStance(score);
  let capNote = "";
  if (severeCrisis && stance > 4) {
    stance = 4;
    capNote = `급락일 상한(종목 ${dayChg?.toFixed(1) ?? "?"}%·시장 ${mDrop?.toFixed(1) ?? "?"}%) — 비중 축소 이하로 제한`;
  } else if (crisis && stance > 5) {
    stance = 5;
    capNote = `급락일 상한(종목 ${dayChg?.toFixed(1) ?? "?"}%·시장 ${mDrop?.toFixed(1) ?? "?"}%) — 중립(매도 우위) 이하로 제한`;
  }
  if (capNote) factors.push({ label: "급락일 상한", pts: 0, signal: "sell", detail: capNote });
  const meta = STANCE7_META[stance];
  const top = [...factors].filter((f) => f.pts !== 0).sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts)).slice(0, 4);
  const reason = (capNote ? `${capNote} · ` : "") + (top.map((f) => `${f.label} ${f.detail}`).join(" · ") || "데이터 부족");

  return {
    ticker: input.ticker, stance, tone: meta.tone, label: meta.label,
    score: Math.round(score), factors, reason,
    sectorCat: cat, focus: prof.focus, dataCount: factors.length,
  };
}
