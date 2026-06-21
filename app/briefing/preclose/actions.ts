"use server";

import { createClient } from "@/lib/supabase/server";
import { getAiClient, hasAiKey } from "@/lib/ai/client";
import { fetchReleaseActual, type FredUnit } from "@/lib/calendar/fred";

const EVENT_SYSTEM = `당신은 한국 개인 투자자를 위한 매크로 애널리스트입니다. 미국 경제지표가 국내 주식시장에 미치는 영향을 분석합니다.
규칙:
1. 반드시 4개 시장에 대한 영향을 각각 짚는다: 국내 주가(코스피/외국인 수급), 반도체(삼성전자·SK하이닉스), 나스닥, 필라델피아 반도체지수(SOX).
2. 단정·투자권유 금지. "~가능성", "~우호적일 수 있습니다" 등 코칭 표현.
3. 모르는 컨센서스(예상치) 숫자를 지어내지 말 것. 주어진 실제값만 사용하고, 예상치는 "직접 확인 필요"로.
4. 간결하게. 한국어로.`;

export type EventInsight = { kind: "outlook" | "analysis"; actual: string | null; text: string };

// 경제지표 전망(발표 전) / 실제값 분석(발표 후)을 AI로 생성
export async function getEventInsight(ev: {
  name: string;
  date: string;
  timeKst: string;
  released: boolean;
  fredSeries?: string;
  unit?: FredUnit;
}): Promise<EventInsight> {
  if (!hasAiKey()) {
    return { kind: ev.released ? "analysis" : "outlook", actual: null, text: "AI 분석을 사용할 수 없습니다(API 키 미설정)." };
  }

  // 발표 후: 실제값(FRED) 확보
  let actualStr: string | null = null;
  if (ev.released && ev.fredSeries && ev.unit) {
    const a = await fetchReleaseActual(ev.fredSeries, ev.unit);
    if (a) actualStr = `${a.latest} · ${a.change}`;
  }

  const prompt = ev.released
    ? `미국 '${ev.name}' 지표가 발표됐습니다(${ev.date}).
${actualStr ? `실제 발표값: ${actualStr} (FRED 실데이터)` : "실제 수치는 직접 확인이 필요합니다."}
이 결과가 국내 주가(코스피·외국인 수급), 반도체(삼성전자·SK하이닉스), 나스닥, 필라델피아 반도체지수(SOX)에 미치는 영향을 각각 1~2문장으로 분석하십시오. 마지막에 한 줄 요약.`
    : `미국 '${ev.name}' 지표가 곧 발표됩니다(${ev.date} ${ev.timeKst} 한국시간).
발표 전 전망으로, 결과가 (a)예상 상회 (b)부합 (c)예상 하회일 때 각각 국내 주가(코스피·외국인 수급), 반도체(삼성전자·SK하이닉스), 나스닥, 필라델피아 반도체지수(SOX)에 어떤 영향이 가능한지 시나리오로 정리하십시오. 컨센서스 숫자는 지어내지 말 것.`;

  try {
    const client = getAiClient();
    const msg = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 700,
      system: EVENT_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content[0].type === "text" ? msg.content[0].text : "";
    return { kind: ev.released ? "analysis" : "outlook", actual: actualStr, text };
  } catch {
    return { kind: ev.released ? "analysis" : "outlook", actual: actualStr, text: "분석 생성에 실패했습니다. 잠시 후 다시 시도하세요." };
  }
}

// 기업 실적 발표 전 전망 (반도체·AI) — 예상 EPS(컨센서스) 포함
export async function getEarningsInsight(e: {
  name: string;
  symbol: string;
  dateKst: string;
  epsForward: number | null;
}): Promise<{ text: string }> {
  if (!hasAiKey()) return { text: "AI 분석을 사용할 수 없습니다(API 키 미설정)." };

  const prompt = `미국 기업 '${e.name}(${e.symbol})' 실적 발표가 예정돼 있습니다(${e.dateKst} 한국시간).${
    e.epsForward !== null ? ` 시장 예상 EPS는 약 ${e.epsForward.toFixed(2)}입니다.` : ""
  }
발표 전 전망으로 정리하십시오:
1. 핵심 체크포인트 — 매출·EPS보다 가이던스, (반도체면) HBM·DDR5·DRAM 가격 전망, 데이터센터 수요, CAPEX, 재고 수준 등 무엇을 봐야 하는지.
2. 시나리오별 영향 — (a) 실적·가이던스 강세 (b) 실적 호조이나 가이던스 보수적 (c) 약세 — 각각 삼성전자·SK하이닉스·반도체 ETF·필라델피아 반도체(SOX)·나스닥에 미치는 영향.
간결하게, 코칭 표현으로, 한국어.`;

  try {
    const client = getAiClient();
    const msg = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 700,
      system: EVENT_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content[0].type === "text" ? msg.content[0].text : "";
    return { text };
  } catch {
    return { text: "전망 생성에 실패했습니다. 잠시 후 다시 시도하세요." };
  }
}

export async function bookmarkNextBriefing(): Promise<void> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const scheduledDate = tomorrow.toISOString().slice(0, 10);

  // UNIQUE(user_id, scheduled_date) 충돌 시 무시
  await supabase.from("briefing_bookmarks").upsert(
    { user_id: user.id, scheduled_date: scheduledDate },
    { onConflict: "user_id,scheduled_date" }
  );
}

export async function hasTodayBookmark(): Promise<boolean> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;

  const today = new Date().toISOString().slice(0, 10);

  const { data } = await supabase
    .from("briefing_bookmarks")
    .select("id")
    .eq("user_id", user.id)
    .eq("scheduled_date", today)
    .maybeSingle();

  return Boolean(data);
}
