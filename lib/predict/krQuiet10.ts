// **'10시 이전에는 불확실성으로 웹사이트 표시 및 문자발송 차단 요청'** (발주자 지시 2026-08-25 —
// 당분간, 별도 해제 지시까지)
// 국장 신모델(하이닉스·삼성전자) 10시 개시 요약: dispatch가 10:00 KST 이전에 억제한 신모델 문자
// (alerts 채널 sms:suppressed·source kr_quiet10)를 10시 이후 첫 크론에서 1건으로 합산 발송하고,
// 현재 유효한 행동(state 기준)을 병기한다. 판정·기록·채점은 계속 — 발송·표시층만 차단
// (웹 /newmodel 동일 게이트). SOXX 아침 요약(soxxV2.ts ⓪)과 같은 취지의 국장판. 해제 = krQuietUntil "".

import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchToChannels } from "@/lib/alerts/dispatch";
import { PREDICT_CONFIG } from "@/lib/predict/config";

type CwSt = { date?: string; dir?: "up" | "down"; entryT?: string; entryPx?: number; cutT?: string; flipT?: string };
type SsSt = { date?: string; entryT?: string; entryDir?: "up" | "down"; entryPx?: number; stop1T?: string; revT?: string; revPx?: number; stop2T?: string };
const DIR = { up: "상승(레버)", down: "하락(인버)" } as const;

export async function runKrQuiet10Flush(): Promise<void> {
  try {
    const qU = PREDICT_CONFIG.newModel.krQuietUntil;
    if (!qU) return;
    const kst = new Date(Date.now() + 9 * 3600e3);
    const kstMin = kst.getUTCHours() * 60 + kst.getUTCMinutes();
    const today = kst.toISOString().slice(0, 10);
    const quietEnd = Number(qU.slice(0, 2)) * 60 + Number(qU.slice(3, 5));
    if (kstMin < quietEnd || kstMin >= quietEnd + 90) return; // 개시 후 90분 창 (크론 지연 여유)
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
    if (dow < 1 || dow > 5) return;

    const admin = createAdminClient();
    const { data: rows } = await admin
      .from("alerts").select("created_at, message")
      .gte("created_at", new Date(`${today}T00:00:00+09:00`).toISOString())
      .order("created_at", { ascending: true });
    type Msg = { alertKey?: string; text?: string; source?: string };
    const seen = new Set<string>();
    const items: { t: string; head: string; act: string | null }[] = [];
    for (const r of rows ?? []) {
      const m = (r.message ?? null) as Msg | null;
      if (!m?.alertKey || m.source !== "kr_quiet10" || seen.has(m.alertKey)) continue;
      seen.add(m.alertKey);
      const t = new Date(new Date(r.created_at as string).getTime() + 9 * 3600e3).toISOString().slice(11, 16);
      const text = m.text ?? "";
      const head = (text.split("\n")[0] ?? "").slice(0, 70);
      const act = (text.split("\n").find((l) => l.trim().startsWith("▶")) ?? "").trim().slice(0, 90) || null;
      items.push({ t, head, act });
    }
    if (items.length === 0) return; // 이른 판정 없음 — 요약 불필요 (이후 문자는 정상 흐름)

    // 현재 유효한 행동 — 억제된 개별 지시 대신 state 기준으로 지금 할 일만 제시
    const { data: stRows } = await admin.from("ops_settings").select("key, value").in("key", ["predict_cw_state", "predict_ssv2_state"]);
    const by = new Map((stRows ?? []).map((r) => [r.key as string, r.value]));
    const cw = (by.get("predict_cw_state") ?? {}) as CwSt;
    const ss = (by.get("predict_ssv2_state") ?? {}) as SsSt;
    const cur: string[] = [];
    if (cw.date === today && cw.entryT && cw.dir) {
      cur.push(cw.cutT ? `하이닉스: 창판정 ${cw.entryT} ${DIR[cw.dir]} → ${cw.cutT} 스탑 종료 — 행동 없음(재진입 없음)`
        : cw.flipT ? `하이닉스: 창판정 ${cw.entryT} ${DIR[cw.dir]} → ${cw.flipT} 전환 청산 — 행동 없음`
        : `하이닉스: 창판정 ${cw.entryT} ${DIR[cw.dir]} 유효 — 미보유면 지금 매수 (판정가 ${cw.entryPx?.toLocaleString() ?? "—"}원 대비 0.7% 초과 진행이면 추격 금지·다음 문자 대기)`);
    } else cur.push("하이닉스: 창판정 없음 — 이후 문자 대기. 10시 이전 사다리(F 30%) 지시분은 실행하지 말고, 이후 문자의 '누적 비중' 표기에 맞춰 실행");
    if (ss.date === today && ss.entryT && ss.entryDir) {
      const curDir: "up" | "down" = ss.revT ? (ss.entryDir === "up" ? "down" : "up") : ss.entryDir;
      const ended = ss.revT ? !!ss.stop2T : !!ss.stop1T;
      const basePx = ss.revT ? ss.revPx : ss.entryPx;
      cur.push(ended ? `삼성전자: ${ss.entryT} 진입 → 스탑 종료 — 행동 없음`
        : `삼성전자: 현재 ${DIR[curDir]} 유효(${ss.revT ? `${ss.revT} 전환` : `진입 판정 ${ss.entryT}`}) — 미보유면 신모델 몫(계좌 70%) 매수 (기준가 ${basePx?.toLocaleString() ?? "—"}원 대비 0.7% 초과 진행이면 추격 금지)·자동스탑 ETF -3%`);
    } else cur.push("삼성전자: 판정 없음(또는 F선행 관망) — 이후 문자 대기");

    const text = `[예측·국장 신모델] 10시 개시 — 10시 이전 판정 요약 ${items.length}건\n`
      + items.map((x) => `· ${x.t} ${x.head}${x.act ? `\n  ${x.act}` : ""}`).join("\n")
      + `\n[지금 유효한 행동]\n${cur.map((l) => `▶${l}`).join("\n")}\n무응답=위 지침 실행\n----\n`
      + `'10시 이전에는 불확실성으로 웹사이트 표시 및 문자발송 차단 요청'(발주자 지시 8/25)에 따라 10시 이전 신모델 문자는 보류하고 이 요약 1건으로 대체합니다. 위 요약의 개별 지시(▶)는 당시 것 — 실행은 [지금 유효한 행동]만. 별도 해제 지시까지 매일 적용 — 기존계층(30%)·SOXX 문자는 종전대로.`;
    await dispatchToChannels("signal", today, { key: "predict_kr_g10", severity: "high", text, smsSubject: "실전(신모델)·국장 10시 개시" });
  } catch { /* 10시 개시 요약 실패는 본 흐름 무관 */ }
}
