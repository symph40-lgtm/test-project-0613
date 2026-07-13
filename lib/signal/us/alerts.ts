// 미국 RV1 발송 정책 — 한국 maybeSendReversalAlert와 동일 원칙 (사용자 지정 2026-07-13):
// 같은 방향 하루 최대 maxPerDirPerDay회, 반복 쿨다운 [10,5]분, 반복은 직전 발송 시점의
// SMH 등락률 대비 그 방향 repeatMinProgressPct 이상 '추가 진행' 시에만 (중복 재감지 차단).
// 중복 방지 창은 ET 거래일 기준. 조용 시간엔 suppressSms로 문자만 억제.

import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchToChannels, type ChannelAlert } from "@/lib/alerts/dispatch";
import { US_SIGNAL_CONFIG as U } from "./config";
import { buildUsReversalAlert, type UsJudgment } from "./engine";

// ── 판정 확정 해제 문자 (사용자 실측 2026-07-13 23:05 — 한 틱 확정 문자 후 반등으로 비추세 회귀,
// 정정 없음). 오늘 확정 문자(us_trend_up/down)가 나갔는데 현재·N분 전 판정 모두 그 방향
// 추세일이 아니면 해제 문자 1회 (1일 1회는 dispatch 중복 방지).
export async function maybeSendUsTrendCancel(
  j: UsJudgment,
  prevJ: UsJudgment | null,
  suppressSms: boolean,
): Promise<number> {
  if (j.phase !== "판정" && j.phase !== "관리") return 0;
  const admin = createAdminClient();
  const windowStartUtc = new Date(`${j.date}T00:00:00-04:00`).toISOString();
  const { data } = await admin
    .from("alerts")
    .select("message")
    .eq("trigger_key", "signal")
    .gte("created_at", windowStartUtc);
  const keys = new Set(
    (data ?? []).map((r) => (r.message as { alertKey?: string } | null)?.alertKey).filter(Boolean) as string[],
  );

  const stillTrend = (dir: "UP" | "DOWN", jj: UsJudgment | null) =>
    jj !== null && jj.trend?.grade === "추세일" && jj.trend.dir === dir;

  let sent = 0;
  for (const [key, dir, name, etf] of [
    ["us_trend_down", "DOWN", "하방", "SSG(-2x)"],
    ["us_trend_up", "UP", "상방", "USD(2x)"],
  ] as const) {
    if (!keys.has(key) || keys.has(`${key}_cancel`)) continue;
    // 현재와 N분 전 모두 그 방향 추세일이 아닐 때만 — 해제 문자도 채터링 방지
    if (stillTrend(dir, j) || stillTrend(dir, prevJ)) continue;
    const alert: ChannelAlert = {
      key: `${key}_cancel`,
      severity: "high",
      smsSubject: `미국 ${name} 확정 해제`,
      text: `[스탁가드 미국] ${name} 확정 해제 — 추세 훼손 (SMH ${j.quotes.smhChg != null ? (j.quotes.smhChg > 0 ? "+" : "") + j.quotes.smhChg.toFixed(1) + "%" : "?"} · 현재 ${j.trend?.grade ?? "판정불가"}) ${etf} 보유 시 점검 [${kstHhmmLocal(j.ts)}]`,
      suppressSms,
    };
    sent += await dispatchToChannels("signal", j.date, alert, `미국 판정 해제 — ${name}`, { us: true, dayType: j.dayType, ts: j.ts });
  }
  return sent;
}

function kstHhmmLocal(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 9 * 3600e3);
  if (!isFinite(d.getTime())) return "--:--";
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export async function maybeSendUsReversalAlert(j: UsJudgment, suppressSms: boolean): Promise<number> {
  const alert = buildUsReversalAlert(j);
  if (!alert) return 0;
  const R = U.reversal;
  const curLevel = j.quotes.smhChg;

  const admin = createAdminClient();
  // ET 거래일 창 — 세션(22:30~05:00 KST)이 KST 자정을 넘으므로 ET 날짜 기준 하루 창 사용
  const windowStartUtc = new Date(`${j.date}T00:00:00-04:00`).toISOString();
  const { data } = await admin
    .from("alerts")
    .select("created_at, message, market_snapshot")
    .eq("trigger_key", "signal")
    .gte("created_at", windowStartUtc);

  const sentKeys = new Map<string, number>();
  let lastMs = 0;
  let lastLevel: number | null = null;
  for (const r of data ?? []) {
    const k = (r.message as { alertKey?: string } | null)?.alertKey;
    if (k && (k === alert.key || k.startsWith(`${alert.key}_`))) {
      const t = Date.parse(r.created_at as string);
      sentKeys.set(k, Math.max(sentKeys.get(k) ?? 0, t));
      if (t > lastMs) {
        lastMs = t;
        const snap = r.market_snapshot as { levelPct?: number | null } | null;
        lastLevel = typeof snap?.levelPct === "number" ? snap.levelPct : null;
      }
    }
  }
  const n = sentKeys.size;
  if (n >= R.maxPerDirPerDay) return 0;
  const cooldownMin = R.repeatCooldownMins[Math.min(n - 1, R.repeatCooldownMins.length - 1)] ?? 0;
  if (n > 0 && Date.now() - lastMs < cooldownMin * 60000) return 0;
  if (n > 0 && lastLevel !== null && curLevel !== null) {
    const progress = alert.key === "us_rev_up" ? curLevel - lastLevel : lastLevel - curLevel;
    if (progress < R.repeatMinProgressPct) return 0;
  }

  const keyed: ChannelAlert = {
    ...alert,
    key: n === 0 ? alert.key : `${alert.key}_${n + 1}`,
    text: n === 0 ? alert.text : `${alert.text} (${n + 1}차)`,
    suppressSms,
  };
  return dispatchToChannels("signal", j.date, keyed, `미국 분봉 모멘텀 — ${keyed.text.slice(10, 45)}`, {
    us: true,
    reversal: j.reversal,
    dayType: j.dayType,
    ts: j.ts,
    levelPct: curLevel,
  });
}
