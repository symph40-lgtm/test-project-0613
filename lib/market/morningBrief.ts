// 아침 브리핑 (사용자 지정 2026-07-08) — 매일 08:30 KST 장문자 1~2건 발송.
//  ①시장: 미2Y·10Y 금리, 환율, 나스닥(QQQ)·반도체(SOXX) 정규+애프터, WTI, 달러지수, VIX,
//    K200 야간선물 — 마지막값·등락률 + 짧은 평가(AI, 없으면 규칙 기반)
//  ②지표: 발표일이 3일 이내인 미국 주요 지표 (FRED 캘린더 + FOMC) — S/A/B/C 등급, D-n,
//    컨센서스·관전포인트 코멘트(AI, 없으면 지표 해석 문구)
// 데이터 한계: ISM PMI·ADP는 FRED 릴리즈 캘린더에 없어 미포함 (민간 발표).

import YahooFinance from "yahoo-finance2";
import { fetchUs2yYield, fetchUs10yYield } from "./rateAlert";
import { fetchKospi200Futures } from "./naver-flow";
import { fetchUpcomingUsEvents, type EconEvent } from "@/lib/calendar/fred";
import { fetchNews } from "@/lib/news/fetch";
import { getAiClient, hasAiKey, parseJsonLoose } from "@/lib/ai/client";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

// 시장 임팩트 등급 (사용자 지정: S=FOMC·CPI·NFP, A=PCE·소매판매 등, B=PPI·JOLTS·GDP, C=그 외)
export function gradeOf(name: string): "S" | "A" | "B" | "C" {
  if (/FOMC|소비자물가|고용보고서/.test(name)) return "S";
  if (/PCE|개인소득|소매판매/.test(name)) return "A";
  if (/생산자물가|JOLTS|구인|GDP|소비자심리|내구재/.test(name)) return "B";
  return "C"; // 실업수당·산업생산·주택 등
}

type Quote = { price: number | null; regChg: number | null; postChg: number | null };

async function usQuote(sym: string): Promise<Quote> {
  try {
    const r = await yf.quote(sym);
    return {
      price: r.postMarketPrice ?? r.regularMarketPrice ?? null,
      regChg: r.regularMarketChangePercent ?? null,
      postChg: r.postMarketChangePercent ?? null,
    };
  } catch {
    return { price: null, regChg: null, postChg: null };
  }
}

const pct = (v: number | null, d = 1) => (v === null ? "?" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
const pp = (v: number | null) => (v === null ? "?" : `${v > 0 ? "+" : ""}${v.toFixed(3)}`);

export type MorningBrief = {
  sms1: string;          // ①시장 (장문)
  sms2: string | null;   // ②지표 (3일 내 지표 없으면 null)
  events: EconEvent[];
};

export async function buildMorningBrief(now: Date = new Date()): Promise<MorningBrief> {
  const kst = new Date(now.getTime() + 9 * 3600e3);
  const todayKst = kst.toISOString().slice(0, 10);
  const md = `${kst.toISOString().slice(5, 7)}/${kst.toISOString().slice(8, 10)}`;

  const [y2, y10, fx, qqq, soxx, wti, dxy, vix, k200f, events] = await Promise.all([
    fetchUs2yYield(),
    fetchUs10yYield(),
    usQuote("KRW=X"),
    usQuote("QQQ"),
    usQuote("SOXX"),
    usQuote("CL=F"),
    usQuote("DX-Y.NYB"),
    usQuote("^VIX"),
    fetchKospi200Futures().catch(() => null),
    fetchUpcomingUsEvents(3),
  ]);

  // 이미 발표된 지표 제외 (사용자 지적 2026-07-15: 전날 21:30 발표된 CPI가 "오늘 21:30 예정"으로
  // 표기됨 — 과거 이벤트가 dday의 n<=0 처리로 '오늘'이 되던 버그). 발표 시각(KST)이 지났으면 제거.
  const upcoming = events.filter((e) => {
    const t = Date.parse(`${e.date}T${(e.timeKst || "23:59").padStart(5, "0")}:00+09:00`);
    return !isFinite(t) || t > now.getTime();
  });

  // 이벤트 D-n (미국 발표일 기준 근사 — KST 날짜와 하루 이내 차이)
  const dday = (d: string) => {
    const n = Math.round((Date.parse(d) - Date.parse(todayKst)) / 86400e3);
    return n <= 0 ? "오늘" : `D-${n}`;
  };

  // AI 평가·지표 코멘트 (키 없거나 실패 시 규칙 기반 폴백)
  let marketComment = ruleComment(y2.change, qqq, soxx);
  const eventComment = new Map<string, string>();
  if (hasAiKey()) {
    try {
      const news = await fetchNews("미국 경제지표 OR CPI OR 고용 OR FOMC 컨센서스", 8).catch(() => []);
      const dirWord = (v: number | null) => (v === null ? "" : v > 0 ? "(상승)" : v < 0 ? "(하락)" : "(보합)");
      const prompt = `너는 한국 반도체 트레이더의 아침 브리핑 보조다. 아래 데이터로 JSON만 출력해라.

## 밤사이 시장 (미국 마감)
미국채 2Y ${y2.value ?? "?"}% (전일 ${pp(y2.change)}%p ${dirWord(y2.change)}) · 10Y ${y10.value ?? "?"}% (${pp(y10.change)}%p ${dirWord(y10.change)})
USD/KRW ${fx.price?.toFixed(0) ?? "?"} (${pct(fx.regChg)}) · 나스닥100 QQQ ${pct(qqq.regChg)} 애프터 ${pct(qqq.postChg)}
반도체 SOXX ${pct(soxx.regChg)} 애프터 ${pct(soxx.postChg)} · WTI ${pct(wti.regChg)} · 달러지수 ${pct(dxy.regChg)} · VIX ${vix.price?.toFixed(1) ?? "?"}

## 3일 내 발표 예정 지표 (이미 발표된 것은 이 목록에 없음 — 발표 결과를 아는 경우에만 뉴스 근거로 언급)
${upcoming.map((e) => `- [${gradeOf(e.name)}급] ${e.name} (${dday(e.date)}, 한국시간 ${e.timeKst})`).join("\n") || "없음"}

## 최근 관련 뉴스
${news.map((n) => `- ${n.title}`).join("\n") || "없음"}

## 출력 (JSON, 다른 텍스트 금지)
{
  "market": "밤사이 시장이 한국 반도체·레버리지 매매에 주는 시사점 2문장 이내 (120자 이내, 단정 대신 '검토/주의' 표현)",
  "events": [{ "name": "지표명(위 목록과 동일하게)", "comment": "컨센서스 예상치가 뉴스에 있으면 수치 포함해 상회/하회 시 시장 반응 1문장, 없으면 관전 포인트 1문장 (60자 이내)" }]
}
부호 해석 규칙 (중요): 괄호의 %p·% 값이 음수(-)면 반드시 '하락', 양수(+)면 '상승'으로 서술해라.
방향 단어와 부호가 어긋난 문장(예: "-0.072%p 상승")은 절대 금지 — 위 데이터의 (상승)/(하락) 표기를 그대로 따라라.
확신 없는 컨센서스 수치는 지어내지 마라 — 그 경우 관전 포인트만 써라.`;
      const res = await getAiClient().messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 700,
        messages: [{ role: "user", content: prompt }],
      });
      const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const parsed = parseJsonLoose<{ market?: string; events?: { name?: string; comment?: string }[] }>(text);
      if (typeof parsed.market === "string" && parsed.market.trim()) marketComment = parsed.market.trim().slice(0, 160);
      for (const e of parsed.events ?? []) {
        if (typeof e.name === "string" && typeof e.comment === "string") eventComment.set(e.name, e.comment.trim().slice(0, 90));
      }
    } catch {
      // 폴백 유지
    }
  }

  // ── 문자 ①시장
  const lines1 = [
    `[스탁가드] 아침브리핑 ①시장 (${md})`,
    `미2Y ${y2.value?.toFixed(3) ?? "?"}% (${pp(y2.change)}%p) · 10Y ${y10.value?.toFixed(3) ?? "?"}% (${pp(y10.change)}%p)`,
    `환율 ${fx.price?.toFixed(0) ?? "?"}원 ${pct(fx.regChg)}`,
    `나스닥(QQQ) 정규 ${pct(qqq.regChg)} 애프터 ${pct(qqq.postChg)}`,
    `반도체(SOXX) 정규 ${pct(soxx.regChg)} 애프터 ${pct(soxx.postChg)}`,
    `WTI ${wti.price?.toFixed(1) ?? "?"} ${pct(wti.regChg)} · 달러지수 ${dxy.price?.toFixed(1) ?? "?"} ${pct(dxy.regChg)}`,
    `VIX ${vix.price?.toFixed(1) ?? "?"} ${pct(vix.regChg)}` +
      (k200f && k200f.price !== null ? ` · K200야간선물 ${k200f.price.toFixed(1)} ${pct(k200f.changePercent)}${k200f.stale ? "(마감값)" : ""}` : ""),
    `평가: ${marketComment}`,
  ];
  const sms1 = lines1.join("\n");

  // ── 문자 ②지표 (3일 내 — 발표 시각이 지난 지표 제외)
  let sms2: string | null = null;
  if (upcoming.length > 0) {
    const lines2 = [`[스탁가드] 아침브리핑 ②지표 (3일 내)`];
    for (const e of upcoming) {
      const g = gradeOf(e.name);
      lines2.push(`[${g}] ${e.name} — ${dday(e.date)} ${e.timeKst}(한국)`);
      const c = eventComment.get(e.name) ?? e.interp;
      if (c) lines2.push(` └ ${c}`);
    }
    sms2 = lines2.join("\n");
  }

  return { sms1, sms2, events };
}

// AI 없을 때 규칙 기반 한 줄 평가
function ruleComment(y2Chg: number | null, qqq: Quote, soxx: Quote): string {
  const rateUp = y2Chg !== null && y2Chg > 0.03;
  const rateDown = y2Chg !== null && y2Chg < -0.03;
  const semiUp = (soxx.regChg ?? 0) > 0.5;
  const semiDown = (soxx.regChg ?? 0) < -0.5;
  if (rateUp && semiDown) return "금리 상승 + 반도체 약세 — 하방 압력, 레버리지 신중.";
  if (rateDown && semiUp) return "금리 하락 + 반도체 강세 — 상방 우호, 신호 확인 후 검토.";
  if (semiUp) return "밤사이 반도체 강세 — 갭상승 출발 가능성, 시초 추격은 자제.";
  if (semiDown) return "밤사이 반도체 약세 — 하락 출발 가능성, 위험선 점검.";
  void qqq;
  return "밤사이 특이 신호 제한적 — 장중 신호 확인 후 대응.";
}
