"use server";

// 운영 설정·지시 서버 액션 (사용자 지정 2026-07-16) — 모바일 /ops 페이지에서 호출.
// 인증된 사용자만. 설정 쓰기는 service role (ops_settings에 쓰기 RLS 없음).

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

async function requireUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");
  return user;
}

// 문자 일시정지 — until(그날까지, KST)·allowStrong(판정 문자는 허용)
export async function setSmsPause(formData: FormData): Promise<void> {
  await requireUser();
  const until = String(formData.get("until") ?? "").trim();
  const allowStrong = formData.get("allowStrong") === "on";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return;
  const admin = createAdminClient();
  await admin.from("ops_settings").upsert(
    { key: "sms_pause", value: { until, allowStrong }, updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
  revalidatePath("/ops");
}

export async function clearSmsPause(): Promise<void> {
  await requireUser();
  const admin = createAdminClient();
  await admin.from("ops_settings").delete().eq("key", "sms_pause");
  revalidatePath("/ops");
}

// 피셔 판정 실시간 알림 (사용자 지시 2026-07-23) — 버튼 문의 시 현재 F/M/본 상태를 계산해
// ①ops_settings(fisher_now_last)에 저장(웹 상세 표시) ②핵심 요약을 문자로 즉시 발송.
// 키에 분(minute) 포함 = 사용자 명시 요청 1회당 1문자 (자동 반복 아님 — 분당 1회 자연 스로틀).
// 개정 (ops 지시 2026-07-23 저녁): 국장은 하닉·삼전 별도 버튼 — market = "hx" | "ss" | "us".
// 15:30 이후 국장 문의는 nowcast가 NXT 애프터장 실시간 판정으로 응답.
export async function queryFisherNow(formData: FormData): Promise<void> {
  await requireUser();
  const raw = String(formData.get("market"));
  // "etf" = TIGER 반도체TOP10 모니터링 (사용자 승인 2026-07-28 밤) · 구값 "kr"은 하닉으로
  const market = raw === "us" ? "us" : raw === "ss" ? "ss" : raw === "etf" ? "etf" : "hx";
  const res = market === "us"
    ? await (await import("@/lib/signal/us/nowcast")).fisherNowUs()
    : market === "etf"
      ? await (await import("@/lib/predict/etfTop10")).fisherNowEtf()
      : await (await import("@/lib/predict/nowcast")).fisherNowKr(market);
  const admin = createAdminClient();
  // 종목·시장별 저장 (사용자 지시 2026-07-25: "하닉만 나옴" — 마지막 1건 대신 각자 보관해 나란히 표시)
  await admin.from("ops_settings").upsert(
    { key: `fisher_now_${market}`, value: res, updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
  try {
    const kst = new Date(Date.now() + 9 * 3600e3);
    const { dispatchToChannels } = await import("@/lib/alerts/dispatch");
    await dispatchToChannels("signal", kst.toISOString().slice(0, 10), {
      key: `predict_now_${market}_${kst.toISOString().slice(11, 16).replace(":", "")}`,
      severity: "low",
      text: res.summary,
      smsSubject: "피셔 실시간",
    });
  } catch { /* 발송 실패해도 웹 상세는 저장됨 */ }
  revalidatePath("/fisher");
  revalidatePath("/ops");
}

// 자유 지시 — 저장만 하고, 다음 Claude 작업 세션에서 읽어 코드에 반영
export async function addDirective(formData: FormData): Promise<void> {
  const user = await requireUser();
  const content = String(formData.get("content") ?? "").trim();
  if (!content) return;
  const admin = createAdminClient();
  await admin.from("ops_directives").insert({ user_id: user.id, content: content.slice(0, 2000) });
  revalidatePath("/ops");
}
