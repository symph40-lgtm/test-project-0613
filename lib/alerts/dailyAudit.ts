// 매일 11:00 문자 발송 감사 (사용자 지시 2026-08-05 밤 "삼전·하닉·SOXX 당일 문자가 빠짐없이
// 발송됐는지, 안 됐으면 이유를 매일 확인해 11:00에 보내줘"):
// 각 신모델 state(판정 사실)와 alerts(발송 기록)를 대조 — state에 이벤트가 있는데 발송 기록이 없으면
// 누락으로 보고하고 원인을 추정(발송 실패 sms:fail / 조용시간 이메일 대체 / 게이트 차단 / 기록 없음).
// 창: 어제 17:00 KST ~ 지금 (SOXX 밤 세션 + 오늘 아침 + 국장 오전). 발송 키 nm_audit(신모델 게이트 밖).
// 8/6 실사고 참고: 하이닉스·삼성전자 지침 문자는 newModel.applyFrom 전에는 '없음이 정상' — live 게이트 반영.

import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchToChannels } from "@/lib/alerts/dispatch";
import { PREDICT_CONFIG } from "@/lib/predict/config";

type AlertRow = { created_at: string; message: { alertKey?: string; channels?: string[] } | null };

function findAlert(rows: AlertRow[], prefix: string): AlertRow | null {
  return rows.find((r) => (r.message?.alertKey ?? "").startsWith(prefix)) ?? null;
}

// 한 이벤트의 발송 상태 판정 → [정상 여부, 설명]
function judge(rows: AlertRow[], prefix: string, label: string): [boolean, string] {
  const a = findAlert(rows, prefix);
  if (!a) return [false, `⚠${label}: 발송 기록 없음 (게이트 차단 또는 서비스 오류 — 세션 점검 필요)`];
  const ch = a.message?.channels ?? [];
  if (ch.some((c) => c === "sms:ok")) return [true, `✓${label}`];
  if (ch.some((c) => c === "sms:retry-ok")) return [true, `✓${label} (1차 실패 → 재시도 성공)`];
  if (ch.some((c) => c === "sms:quiet")) return [true, `✓${label} (00~07시 정책 — 이메일·아침요약 대체)`];
  if (ch.some((c) => c === "sms:fail")) return [false, `⚠${label}: SMS 발송 실패 (Solapi 오류 — 잔액·번호 확인)`];
  return [true, `✓${label} (이메일)`];
}

export async function runDailySmsAudit(): Promise<void> {
  try {
    const kst = new Date(Date.now() + 9 * 3600e3);
    const kstMin = kst.getUTCHours() * 60 + kst.getUTCMinutes();
    const today = kst.toISOString().slice(0, 10);
    if (kstMin < 11 * 60 || kstMin > 11 * 60 + 20) return; // 11:00~11:20 창
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    if (dow < 1 || dow > 6) return; // 월~토 (토요일은 금요 미장 세션 감사)

    const admin = createAdminClient();
    const { data: doneRow } = await admin.from("ops_settings").select("value").eq("key", "nm_audit_state").maybeSingle();
    if ((doneRow?.value as { date?: string } | null)?.date === today) return; // 1일 1회

    // 어제 17:00 KST부터의 발송 기록 (SOXX 밤 세션 전체 + 오늘 아침·오전)
    const fromIso = new Date(new Date(`${today}T17:00:00+09:00`).getTime() - 24 * 3600e3).toISOString();
    const { data: alertRows } = await admin
      .from("alerts").select("created_at, message").gte("created_at", fromIso).order("created_at", { ascending: true });
    const rows = (alertRows ?? []) as AlertRow[];

    const { data: stRows } = await admin
      .from("ops_settings").select("key, value")
      .in("key", ["uspredict_v2_state", "predict_cw_state", "predict_ssv2_state"]);
    const stBy = new Map((stRows ?? []).map((r) => [r.key as string, r.value as Record<string, unknown>]));
    const us = stBy.get("uspredict_v2_state") ?? {};
    const cw = stBy.get("predict_cw_state") ?? {};
    const ss = stBy.get("predict_ssv2_state") ?? {};
    const NM = PREDICT_CONFIG.newModel;
    const soxxLive = (NM.soxxApplyFrom !== "" ? NM.soxxApplyFrom : NM.applyFrom) !== "" ;
    const krLive = NM.applyFrom !== "" && today >= NM.applyFrom; // 하이닉스 사다리·삼성전자 지침 (8/6~)

    const lines: string[] = [];
    let issues = 0;
    const check = (cond: unknown, prefix: string, label: string) => {
      if (!cond) return;
      const [ok, msg] = judge(rows, prefix, label);
      lines.push(msg);
      if (!ok) issues++;
    };

    // SOXX (밤 세션 — state는 감사 시점에 그 세션을 그대로 보유)
    if (soxxLive) {
      check(us.entryT, "uspredict_v2_entry_", `SOXX 진입(${us.entryT ?? ""} ET)`);
      check(us.confT, "uspredict_v2_conf_", "SOXX 동의 확인");
      check(us.oppT, "uspredict_v2_opp_", "SOXX 이견 통지");
      check(us.revT, "uspredict_v2_rev_", "SOXX 전환");
      check(us.stopT, "uspredict_v2_stop_", "SOXX 스탑");
      check(us.protT, "uspredict_v2_prot_", "SOXX 이익 보호");
      check(us.preBriefDone, "uspredict_v2_pre", "SOXX 프리장 브리핑");
      check(us.bedDone, "uspredict_v2_bed", "SOXX 취침 지침");
      check(us.eodDone, "uspredict_v2_eod", "SOXX 결산");
      check(us.eodDone, "uspredict_v2_am", "SOXX 아침 요약");
    }
    // 하이닉스 (오늘 국장 오전 — state.date가 오늘일 때만)
    if (cw.date === today) {
      check(cw.entryT, "predict_cw_entry_", `하이닉스 창판정 진입(${cw.entryT ?? ""})`);
      check(cw.cutT, "predict_cw_cut_", "하이닉스 창판정 스탑");
      check(cw.flipT, "predict_cw_flip", "하이닉스 창판정 전환");
    }
    // 삼성전자 (지침 문자는 applyFrom부터 — 이전엔 기록만이 정상)
    if (krLive && ss.date === today) {
      check(ss.entryT, "predict_ssv2_entry_", `삼성전자 진입(${ss.entryT ?? ""})`);
      check(ss.confT, "predict_ssv2_conf_", "삼성전자 동의 확인");
      check(ss.revT, "predict_ssv2_rev_", "삼성전자 전환");
      check(ss.stop1T, "predict_ssv2_stop_", "삼성전자 스탑");
    }
    // 공통 아침 브리핑 (오늘 07:45 예정 — Vercel 크론 + cron-job.org 이중화)
    {
      const todayRows = rows.filter((r) => r.created_at >= new Date(`${today}T07:00:00+09:00`).toISOString());
      const [ok, msg] = judge(todayRows, "morning_brief_1", "아침 브리핑");
      lines.push(msg);
      if (!ok) issues++;
    }

    if (!lines.length) lines.push("점검 대상 이벤트 없음 (판정 없는 날)");
    const head = issues === 0 ? "정상 — 전 채널 빠짐없이 발송" : `⚠누락·실패 ${issues}건`;
    try {
      await dispatchToChannels("signal", today, {
        key: "nm_audit", severity: issues === 0 ? "low" : "medium",
        text: `[문자 발송 점검] ${head}\n${lines.join("\n")}\n----\n매일 11:00 자동 감사 (사용자 지시 8/5): 각 신모델 판정 기록 vs 실제 발송 대조. 누락 시 원인 추정 동봉 — 반복되면 /ops 지시함에 남겨주세요.`,
        smsSubject: "발송 점검",
      });
    } catch { /* 감사 발송 실패는 무시 */ }
    await admin.from("ops_settings").upsert({ key: "nm_audit_state", value: { date: today, issues }, updated_at: new Date().toISOString() }, { onConflict: "key" });
  } catch { /* 감사 실패는 본 흐름을 막지 않는다 */ }
}
