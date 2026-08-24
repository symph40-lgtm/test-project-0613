// 신모델 현황 (사용자 지시 2026-08-05 밤 "삼전·하닉·SOXX 최신 모델을 스탁가드 인터넷으로 확인") —
// 하이닉스(창판정+4단 사다리)·삼성전자(v2)·SOXX(v2 통합)의 오늘 상태·누적 채점을 한 화면에.
// 데이터: ops_settings의 각 신모델 state/scores 키 (문자와 동일 원천 — 크론이 매분 갱신).

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageShell, Disclaimer } from "../_components/Shell";

export const dynamic = "force-dynamic";

type CwState = { date?: string; dir?: "up" | "down"; entryT?: string; entryPx?: number; cutT?: string; flipT?: string; eodDone?: boolean };
type CwScore = { date: string; dir: "up" | "down"; entryT: string; holdPnl: number; flipPnl: number; cut: boolean };
type LadderScore = { date: string; pnl: number; cut: boolean; def: boolean };
type SsState = { date?: string; entryT?: string; entryDir?: "up" | "down"; entryPx?: number; stop1T?: string; confT?: string; revT?: string; stop2T?: string };
type SsScore = { date: string; p: number; p5: number; p4: number; p12: number; cut: boolean; note?: string };
type UsState = {
  date?: string; entryT?: string; entryDir?: "up" | "down"; entryPx?: number; entryKind?: "cw" | "f";
  confT?: string; oppT?: string; revT?: string; revPx?: number; stopT?: string; protT?: string;
  ovn?: { date: string; dir: 1 | -1; px: number } | null;
};
type UsScore = { date: string; p: number; pRe: number; pV0: number; pNP?: number; cut: boolean; kind: string; ovn: boolean; pend?: boolean };
// 국장 1박 채점 (predict_cw_ovn·predict_ssv2_ovn) — raw = 100% 환산 원값, wtd = 비중 반영값
type KrOvn = { date: string; dir: 1 | -1; px: number; w: number; t1: string; gap: boolean; raw?: number; wtd?: number; openPx?: number };

const DIR_KO = { up: "상승(레버)", down: "하락(인버)" } as const;
const won = (v?: number) => (v != null ? v.toLocaleString() : "—");
const pp = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const sum = <T,>(arr: T[], f: (x: T) => number) => arr.reduce((a, x) => a + f(x), 0);

function DirBadge({ dir }: { dir?: "up" | "down" }) {
  if (!dir) return null;
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${dir === "up" ? "bg-red-50 text-red-600" : "bg-blue-50 text-blue-600"}`}>
      {DIR_KO[dir]}
    </span>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-hairline/40 py-1.5 text-[13px] last:border-b-0">
      <span className="shrink-0 text-ink-48">{label}</span>
      <span className="text-right text-ink-80">{value}</span>
    </div>
  );
}

function Card({ title, badge, children }: { title: string; badge: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-[18px] border border-hairline bg-canvas p-5">
      <div className="mb-2 flex items-center gap-2">
        <p className="text-[15px] font-semibold">{title}</p>
        <span className="rounded-full bg-pearl px-2 py-0.5 text-[11px] font-semibold text-ink-48">{badge}</span>
      </div>
      {children}
    </div>
  );
}

export default async function NewModelPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("ops_settings")
    .select("key, value, updated_at")
    .in("key", ["predict_cw_state", "predict_cw_scores", "predict_cw_ladder", "predict_cw_ovn", "predict_ssv2_state", "predict_ssv2_scores", "predict_ssv2_ovn", "uspredict_v2_state", "uspredict_v2_scores"]);
  const byKey = new Map((rows ?? []).map((r) => [r.key as string, r]));
  const val = <T,>(k: string): T | null => (byKey.get(k)?.value as T | undefined) ?? null;

  const cwSt = val<CwState>("predict_cw_state");
  const cwSc = (val<CwScore[]>("predict_cw_scores") ?? []);
  const ladder = (val<LadderScore[]>("predict_cw_ladder") ?? []);
  const ssSt = val<SsState>("predict_ssv2_state");
  const ssSc = (val<SsScore[]>("predict_ssv2_scores") ?? []);
  // 국장 1박 (사용자 확정 8/8) — 자격일 종가 보유 → 다음 거래일 09:00 시가 청산
  const hxOvn = (val<KrOvn[]>("predict_cw_ovn") ?? []);
  const ssOvn = (val<KrOvn[]>("predict_ssv2_ovn") ?? []);
  const usSt = val<UsState>("uspredict_v2_state");
  const usSc = (val<UsScore[]>("uspredict_v2_scores") ?? []);
  const usUpdated = byKey.get("uspredict_v2_state")?.updated_at as string | undefined;

  // ── 지금 할 액션 + 오늘 문자 타임라인 (사용자 지시 8/5 밤 "당일 문자 정리 + 지금 어떤 액션인지 위에")
  const kstNow = new Date(Date.now() + 9 * 3600e3);
  const kstMin = kstNow.getUTCHours() * 60 + kstNow.getUTCMinutes();
  const kstToday = kstNow.toISOString().slice(0, 10);

  const usNm = (d?: "up" | "down" | 1 | -1) => (d === "up" || d === 1 ? "SOXL" : "SOXS");
  let soxxAction = "판정 대기 — 진입 문자가 오면 그대로 실행 (F 창은 한국 20:00 개시)";
  if (usSt?.ovn) {
    const dis = (usSt.ovn.px * (usSt.ovn.dir === 1 ? 0.95 : 1.05)).toFixed(2);
    soxxAction = `1박 보유 중 (${usNm(usSt.ovn.dir)}) → 22:30 개장 시가에 전량 매도 (문자 예정) · 그때까지 자동감시 재난선 SOXX ${dis}`;
  } else if (usSt?.entryT && (usSt.stopT || usSt.protT)) {
    soxxAction = `오늘 세션 매매 종료 (${usSt.protT ? "이익 보호 청산" : "스탑"}) — 행동 없음, 다음 세션 문자 대기`;
  } else if (usSt?.entryT && usSt.entryPx) {
    const dir = usSt.revT ? undefined : usSt.entryDir;
    const px = usSt.revPx ?? usSt.entryPx;
    const stop = (px * (dir === "up" ? 0.98 : 1.02)).toFixed(2);
    const tail = usSt.confT ? "1박 자격 — 취침 시 무행동, 재난선으로 전환은 취침 문자 참조" : usSt.oppT ? "1박 금지 — 취침 전 MOC(또는 LOC 저가) 매도 예약" : "동의/이견 문자 대기";
    soxxAction = `보유 ${usNm(usSt.entryDir)} 유지 — 자동감시 SOXX ${stop} · ${tail}`;
  }

  const krAction = (st: { date?: string; entryT?: string; entryDir?: "up" | "down" } | null, cutT?: string, ovn: KrOvn[] = []): string => {
    // 전 거래일 1박분이 아직 안 팔린 상태 (오늘 09:00 시가 청산 대상)
    const carry = ovn.find((r) => r.raw === undefined && r.date < kstToday);
    if (carry && kstMin < 9 * 60 + 10) return `어젯밤 1박 보유 중 (비중 ${carry.w * 100}%·기준가 ${won(carry.px)}원) — 09:00 시가에 전량 매도`;
    if (!st || st.date !== kstToday || !st.entryT) return "오늘 판정 없음 — 행동 없음";
    if (cutT) return `스탑 종료(${cutT}) — 행동 없음, 내일 문자 대기`;
    const tonight = ovn.find((r) => r.date === kstToday && r.raw === undefined);
    if (kstMin >= 15 * 60 + 30) {
      return tonight
        ? `1박 보유 중 (비중 ${tonight.w * 100}%) — 내일 09:00 시가 전량 매도 · 밤 구간은 스탑 설정만(갭이면 미체결 — 시가 청산)`
        : "장 마감(종가 청산) — 행동 없음, 내일 문자 대기";
    }
    return `${st.entryDir === "up" ? "레버" : "인버"} 보유 유지 — 15:30 종가 전량 매도, 1박 자격이면 결산 문자로 유지 지시 (전환·스탑 문자 오면 그 지침 우선)`;
  };
  const hxAction = krAction(cwSt as { date?: string; entryT?: string; entryDir?: "up" | "down" }, (cwSt as { cutT?: string })?.cutT, hxOvn);
  const ssAction = krAction(ssSt as { date?: string; entryT?: string; entryDir?: "up" | "down" }, (ssSt as { stop1T?: string })?.stop1T, ssOvn);
  // 카드에 병기할 1박 누적 (원값 = 전부 100% 환산 · 비중반영 = 확정 배분)
  const ovnLine = (arr: KrOvn[]): string => {
    const done = arr.filter((r) => r.raw !== undefined);
    if (!done.length) return "아직 없음 (자격일 종가부터 기록)";
    return `${pp(sum(done, (r) => r.wtd ?? 0))} (${done.length}일 · 원값 ${pp(sum(done, (r) => r.raw ?? 0))} · 100%일 ${done.filter((r) => r.w === 1).length})`;
  };

  // 오늘(KST) 발송 문자 타임라인
  const { data: todayAlerts } = await admin
    .from("alerts").select("created_at, message")
    .gte("created_at", new Date(`${kstToday}T00:00:00+09:00`).toISOString())
    .order("created_at", { ascending: true });
  const LABELS: [RegExp, string][] = [
    [/^uspredict_v2_entry/, "SOXX 진입"], [/^uspredict_v2_conf/, "SOXX 동의(1박 자격)"], [/^uspredict_v2_opp/, "SOXX 이견(1박 금지)"],
    [/^uspredict_v2_rev/, "SOXX 전환"], [/^uspredict_v2_stop/, "SOXX 스탑"], [/^uspredict_v2_prot/, "SOXX 이익 보호"],
    [/^uspredict_v2_ovn/, "SOXX 1박 청산"], [/^uspredict_v2_bed/, "SOXX 취침 지침"], [/^uspredict_v2_eod/, "SOXX 결산"],
    [/^uspredict_v2_am/, "SOXX 아침 요약"], [/^uspredict_v2_pre/, "SOXX 프리장 브리핑"], [/^uspredict_v2_start/, "SOXX 시범 시작"],
    [/^predict_cw_entry/, "하이닉스 창판정 진입"], [/^predict_cw_cut/, "하이닉스 창판정 스탑"], [/^predict_cw_flip/, "하이닉스 창판정 전환"],
    [/^predict_cw_eod/, "하이닉스 창판정 결산"], [/^predict_nm_cmp/, "하이닉스 신모델 비교"], [/^predict_nm_start/, "하이닉스 시범 시작"],
    [/^predict_tr_hxF/, "하이닉스 F 판정"], [/^predict_prog5_hxF/, "하이닉스 진행성"],
    [/^predict_ssv2_entry/, "삼성전자 진입"], [/^predict_ssv2_rev/, "삼성전자 전환"], [/^predict_ssv2_stop/, "삼성전자 스탑"],
    [/^predict_ssv2_conf/, "삼성전자 동의"], [/^predict_ssv2_eod/, "삼성전자 결산"], [/^predict_ssv2_start/, "삼성전자 시범 시작"],
    // [발주자 확인 8/24] 미표기 누락 보강 — 피셔 M/본(하닉·삼전)·삼전 진입결정(10시)·1박 청산·당일청산 지시:
    // 로그(alerts)엔 전수 기록되는데 이 필터에 없어 화면 타임라인에서 빠졌던 8건 계열
    [/^predict_tr_hx/, "하이닉스 피셔 판정"], [/^predict_tr_ss/, "삼성전자 피셔 판정"],
    [/^predict_prog5_hx/, "하이닉스 진행성"], [/^predict_prog5_ss/, "삼성전자 진행성"],
    [/^predict_ss_delay/, "삼성전자 진입결정(10시)"], [/^predict_ssv2_ovn/, "삼성전자 1박"], [/^predict_cw_ovn/, "하이닉스 1박"],
    [/^predict_sell/, "하이닉스 당일청산 지시(15:10)"],
    [/^nm_audit/, "발송 점검"], [/^morning_/, "아침 브리핑"],
  ];
  const seen = new Set<string>();
  // result = 문자 첫 줄에서 [제목] 뗀 판정 결과 · dir = 인버(파랑)/레버(빨강) 색 구분 (발주자 표기 지시 8/24 밤)
  const timeline: { t: string; label: string; head: string; result: string; dir: "up" | "down" | null; action: string | null }[] = [];
  for (const r of todayAlerts ?? []) {
    const m = r.message as { alertKey?: string; text?: string } | null;
    const k = m?.alertKey ?? "";
    if (!k || seen.has(k)) continue;
    const lab = LABELS.find(([re]) => re.test(k));
    if (!lab) continue; // 신모델·점검 계열만
    seen.add(k);
    const kst = new Date(new Date(r.created_at as string).getTime() + 9 * 3600e3).toISOString().slice(11, 16);
    const text = m?.text ?? "";
    const head = text.split("\n").slice(0, 2).join(" ").slice(0, 90);
    const line1 = text.split("\n")[0] ?? "";
    const result = (line1.replace(/^\[[^\]]*\]\s*/, "") || line1).slice(0, 72);
    const kd = `${k} ${line1}`;
    const dir: "up" | "down" | null = /inverse|인버|하락|SOXS/.test(kd) ? "down" : /leverage|레버|상승|SOXL/.test(kd) ? "up" : null;
    // 액션 병기 (발주자 지시 8/24 밤 2차): 문자 본문의 첫 ▶줄 = 그 판정에서 해야 할 매도·매수·비율
    const action = (text.split("\n").find((l) => l.trim().startsWith("▶")) ?? "").replace(/^▶\s*/, "").slice(0, 96) || null;
    timeline.push({ t: kst, label: lab[1], head, result, dir, action });
  }

  // 판정 결과 통합 섹션 (발주자 지시 8/24 밤 — '지금 할 액션' 바로 아래): 창판정 무판정일에도
  // 피셔 트랙(F/M/본)·진행성·1박·청산·매도매수 판정 전부. 문자 발송(기록)마다 자동 반영 — 애프터장 마감까지.
  const hxTimeline = timeline.filter((x) => x.label.startsWith("하이닉스"));
  const ssTimeline = timeline.filter((x) => x.label.startsWith("삼성전자"));
  const usTl = timeline.filter((x) => x.label.startsWith("SOXX"));

  // SOXX 오늘 타임라인 문자열 (ET 표기 — 문자와 동일)
  const usTimeline: string[] = [];
  if (usSt?.entryT) usTimeline.push(`${usSt.entryT} ET ${usSt.entryKind === "f" ? "F 확인" : "창1 판정"} 진입 $${usSt.entryPx?.toFixed(2) ?? "—"}`);
  if (usSt?.confT) usTimeline.push(`${usSt.confT} ET 동의 확인 — 1박 자격`);
  if (usSt?.oppT) usTimeline.push(`${usSt.oppT} ET F 이견 — 1박 금지(보유 유지)`);
  if (usSt?.revT) usTimeline.push(`${usSt.revT} ET 전환(창1 반대)`);
  if (usSt?.protT) usTimeline.push(`${usSt.protT} ET 이익 보호 청산`);
  if (usSt?.stopT) usTimeline.push(`${usSt.stopT} ET 스탑 컷`);
  if (!usTimeline.length) usTimeline.push("오늘 세션 판정 대기 (F 창 20:00 KST~)");

  return (
    <PageShell title="신모델 현황" badge="NEW MODEL" width="default">
      <p className="mb-4 text-[13px] leading-relaxed text-ink-48">
        실전(신모델) 문자와 같은 원천 데이터입니다 — 매분 크론이 갱신합니다. 매매 기준은 항상{" "}
        <b>실전(신모델) 문자</b>이고, 이 화면은 확인용입니다.
      </p>

      {/* ⓪ 지금 할 액션 (최상단 — 사용자 지시 8/5 밤) */}
      <div className="mb-4 rounded-[18px] border-2 border-guard/40 bg-canvas p-5">
        <p className="mb-2 text-[15px] font-semibold">지금 할 액션 <span className="text-[11px] font-normal text-ink-48">({kstToday} {`${String(Math.floor(kstMin / 60)).padStart(2, "0")}:${String(kstMin % 60).padStart(2, "0")}`} KST 기준)</span></p>
        <Row label="SOXX" value={<b>{soxxAction}</b>} />
        <Row label="하이닉스" value={hxAction} />
        <Row label="삼성전자" value={ssAction} />
        <p className="mt-2 text-[11px] text-ink-48">새 문자가 오면 항상 문자 지침이 이 화면보다 우선입니다.</p>
      </div>

      {/* ⓪a 판정 결과 (발주자 지시 8/24 밤 — 액션 바로 아래) : 한 줄 1판정 · 시각/판정결과 볼드 · 인버스 파랑·레버 빨강.
          문자 기록마다 반영(애프터장 마감까지, 매도매수 판정 포함) — 60초 자동 새로고침 */}
      <div className="mb-4 rounded-[18px] border border-hairline bg-canvas p-5">
        <p className="mb-2 text-[14px] font-semibold">판정 결과 (오늘 — 문자 기준·자동 갱신)</p>
        {([["삼성전자", ssTimeline], ["하이닉스", hxTimeline], ["SOXX", usTl]] as const).map(([nm, arr]) => (
          <div key={nm} className="mb-2 last:mb-0">
            <p className="text-[12px] font-semibold text-ink-48">■ {nm}</p>
            {arr.length === 0 ? (
              <p className="py-0.5 text-[13px] text-ink-48">오늘 판정 없음</p>
            ) : (
              arr.map((x) => (
                <p key={`${x.t}${x.label}${x.result}`} className="py-0.5 text-[13px] leading-snug">
                  <b className="font-mono text-[12px]">{x.t}</b>{" "}
                  <span className="text-[12px] text-ink-48">{x.label.replace(new RegExp(`^${nm} `), "")}</span>{" "}
                  <b className={x.dir === "down" ? "text-blue-600" : x.dir === "up" ? "text-red-600" : "text-ink-80"}>{x.result}</b>
                  {x.action ? <span className="block pl-4 text-[12px] font-semibold text-amber-700">→ 할 일: {x.action}</span> : null}
                </p>
              ))
            )}
          </div>
        ))}
        <p className="mt-1 text-[11px] text-ink-48">인버스 = <b className="text-blue-600">파랑</b> · 레버 = <b className="text-red-600">빨강</b>. 애프터장 마감까지 새 판정이 이 목록에 계속 쌓입니다 (60초 자동 새로고침).</p>
      </div>
      <script dangerouslySetInnerHTML={{ __html: "setTimeout(function(){location.reload()},60000)" }} />

      {/* ⓪b 오늘 문자 타임라인 */}
      <div className="mb-4 rounded-[18px] border border-hairline bg-canvas p-5">
        <p className="mb-2 text-[14px] font-semibold">오늘 발송된 문자 ({timeline.length}건)</p>
        {timeline.length === 0 ? (
          <p className="text-[13px] text-ink-48">아직 없음</p>
        ) : (
          <ul className="space-y-1.5">
            {timeline.map((x) => (
              <li key={`${x.t}${x.label}`} className="text-[13px]">
                <span className="mr-2 font-mono text-[12px] text-ink-48">{x.t}</span>
                <b>{x.label}</b>
                <span className="ml-2 text-[12px] text-ink-48">{x.head}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* SOXX v2 */}
      <Card title="SOXX 신모델 v2" badge="시범 중 (8/4~)">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[12px] text-ink-48">세션 {usSt?.date ?? "—"} (ET)</span>
          <DirBadge dir={usSt?.entryDir} />
        </div>
        {usTimeline.map((t) => (
          <p key={t} className="py-0.5 text-[13px] text-ink-80">· {t}</p>
        ))}
        {usSt?.ovn ? (
          <p className="mt-1 rounded-[10px] bg-amber-50 px-3 py-1.5 text-[12px] text-amber-700">
            1박 보유 중: {usSt.ovn.dir === 1 ? "SOXL" : "SOXS"} (기준가 ${usSt.ovn.px.toFixed(2)}) — 22:30 KST 개장 시가 매도 예정
          </p>
        ) : null}
        <div className="mt-3">
          <Row label={`누적 ${usSc.length}일 (주기준: rebox+인버보호+프리진입)`} value={<b>{pp(sum(usSc, (s) => s.p))}</b>} />
          <Row label="보호없음판 / 역진입판 / 무rebox판" value={`${pp(sum(usSc, (s) => s.pNP ?? s.p))} / ${pp(sum(usSc, (s) => s.pRe))} / ${pp(sum(usSc, (s) => s.pV0))}`} />
          {usSc.slice(-5).reverse().map((s) => (
            <Row key={s.date} label={s.date} value={`${pp(s.p)}${s.cut ? " 컷" : ""}${s.ovn ? (s.pend ? " · 1박 중(시가 확정 대기)" : " · 1박") : ""}`} />
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-48">
          규칙: 창1(1분 6봉)·F(07시창) 중 먼저 온 신호 100% 진입(프리장 확인가 직접 매수) · F선행일 창1 반대 시 전환 ·
          비이견일 1박(다음 세션 시가 청산) · 스탑 -2%(밤 재난선 -5%) · 인버스 +1% 후 0.9% 반등 시 이익 보호. 근거 246일 +141.6%p.
          표의 일별·누적 %는 <b>판정 방향을 반영한 SOXX 지수 기준 가상 수익률</b>(하락 판정일은 하락분이 +) — SOXL/SOXS 배율·수수료 미반영.
          {usUpdated ? ` · 갱신 ${new Date(new Date(usUpdated).getTime() + 9 * 3600e3).toISOString().slice(5, 16).replace("T", " ")} KST` : ""}
        </p>
      </Card>

      {/* 하이닉스 */}
      <Card title="하이닉스 신모델 (창판정 + 4단 사다리)" badge="창판정 가동 · 사다리 지침 8/6~">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[12px] text-ink-48">오늘 {cwSt?.date ?? "—"}</span>
          <DirBadge dir={cwSt?.dir} />
        </div>
        <Row label="창판정 진입" value={cwSt?.entryT ? `${cwSt.entryT} @ ${won(cwSt.entryPx)}원` : "판정 없음"} />
        {cwSt?.cutT ? <Row label="스탑" value={`${cwSt.cutT} (재진입 없음)`} /> : null}
        {cwSt?.flipT ? <Row label="전환 청산" value={cwSt.flipT} /> : null}
        <div className="mt-3">
          <Row label={`창판정 누적 ${cwSc.length}일 (종가보유 기준)`} value={<b>{pp(sum(cwSc, (s) => s.holdPnl))}</b>} />
          <Row label="가상 사다리 채점 누적" value={`${pp(sum(ladder, (s) => s.pnl))} (${ladder.length}일)`} />
          <Row label="1박 누적 (비중반영)" value={ovnLine(hxOvn)} />
          {cwSc.slice(-5).reverse().map((s) => (
            <Row key={s.date} label={`${s.date} ${DIR_KO[s.dir]}`} value={`${pp(s.holdPnl)}${s.cut ? " 컷" : ""}`} />
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-48">
          규칙: F 30%(방어일 15%) → 진행성 충족 70% → 전진 0.3/창동의 100% · 이견 청산+재진입 · 스탑 -2.5%(ETF -5%) ·
          당일 종가 청산 · 서킷 K3M2. 227일 +120.7%p. 사다리 증액 지침 문자는 8/6 시범부터.
          1박(8/8~ 페이퍼): 창·F 동의일은 종가 보유 → 익일 09:00 시가 청산, 비중은 창 확인 ≤10:00·비갭이면 100%·나머지 50% (217일 +192.2%p).
          표의 일별·누적 %는 <b>판정 방향(레버/인버)을 반영한 본주 가격 기준 가상 수익률</b>(인버 판정일은 하락분이 +) — ETF 배율·수수료 미반영.
          일별 행은 <b>창판정 진입일만</b> 기록 — 무판정일(피셔 트랙만 진행한 날 포함)은 표본 제외라 날짜가 빕니다(0% 아님).
        </p>
      </Card>

      {/* 삼성전자 */}
      <Card title="삼성전자 신모델 v2" badge="지침 문자 8/6~">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[12px] text-ink-48">오늘 {ssSt?.date ?? "—"}</span>
          <DirBadge dir={ssSt?.entryDir} />
        </div>
        <Row label="창 판정 진입" value={ssSt?.entryT ? `${ssSt.entryT} @ ${won(ssSt.entryPx)}원` : "판정 없음(관망)"} />
        {ssSt?.confT ? <Row label="F 동의 확인" value={ssSt.confT} /> : null}
        {ssSt?.revT ? <Row label="F 반대 — 전량 전환" value={ssSt.revT} /> : null}
        {ssSt?.stop1T ? <Row label="스탑(정찰 레그)" value={ssSt.stop1T} /> : null}
        {ssSt?.stop2T ? <Row label="스탑(전환 레그)" value={ssSt.stop2T} /> : null}
        <div className="mt-3">
          <Row label={`누적 ${ssSc.length}일 (6봉 주기준)`} value={<b>{pp(sum(ssSc, (s) => s.p))}</b>} />
          <Row label="5봉 / 4봉 / 1.2판 (대조)" value={`${pp(sum(ssSc, (s) => s.p5))} / ${pp(sum(ssSc, (s) => s.p4))} / ${pp(sum(ssSc, (s) => s.p12))}`} />
          <Row label="1박 누적 (비중반영)" value={ovnLine(ssOvn)} />
          {ssSc.slice(-5).reverse().map((s) => (
            <Row key={s.date} label={`${s.date}${s.note ? ` (${s.note})` : ""}`} value={`${pp(s.p)}${s.cut ? " 컷" : ""}`} />
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-48">
          규칙: 창(6봉 누적 순전진 1.0) 100% 진입 → 피셔F 반대 확인 시 전량 전환 → 종가 청산 · 스탑 ETF -3% ·
          F 선행일 관망 · 창 전환 무시. 232일 +112.8%p(F 0930 rebox판). 진입/전환 지침 문자는 8/6 시범부터.
          1박(8/8~ 페이퍼): 창·F 동의일은 종가 보유 → 익일 09:00 시가 청산, 비중은 창 확인 ≤10:00·비갭이면 100%·나머지 50% (217일 +198.5%p).
          표의 일별·누적 %는 <b>판정 방향(레버/인버)을 반영한 본주 가격 기준 가상 수익률</b>(인버 판정일은 하락분이 + — 예: 8/24 +5.69% = 인버스 기준) — ETF 배율·수수료 미반영.
        </p>
      </Card>

      <Disclaimer />
    </PageShell>
  );
}
