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
  confT?: string; oppT?: string; revT?: string; stopT?: string; protT?: string;
  ovn?: { date: string; dir: 1 | -1; px: number } | null;
};
type UsScore = { date: string; p: number; pRe: number; pV0: number; pNP?: number; cut: boolean; kind: string; ovn: boolean; pend?: boolean };

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
    .in("key", ["predict_cw_state", "predict_cw_scores", "predict_cw_ladder", "predict_ssv2_state", "predict_ssv2_scores", "uspredict_v2_state", "uspredict_v2_scores"]);
  const byKey = new Map((rows ?? []).map((r) => [r.key as string, r]));
  const val = <T,>(k: string): T | null => (byKey.get(k)?.value as T | undefined) ?? null;

  const cwSt = val<CwState>("predict_cw_state");
  const cwSc = (val<CwScore[]>("predict_cw_scores") ?? []);
  const ladder = (val<LadderScore[]>("predict_cw_ladder") ?? []);
  const ssSt = val<SsState>("predict_ssv2_state");
  const ssSc = (val<SsScore[]>("predict_ssv2_scores") ?? []);
  const usSt = val<UsState>("uspredict_v2_state");
  const usSc = (val<UsScore[]>("uspredict_v2_scores") ?? []);
  const usUpdated = byKey.get("uspredict_v2_state")?.updated_at as string | undefined;

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
          {cwSc.slice(-5).reverse().map((s) => (
            <Row key={s.date} label={`${s.date} ${DIR_KO[s.dir]}`} value={`${pp(s.holdPnl)}${s.cut ? " 컷" : ""}`} />
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-48">
          규칙: F 30%(방어일 15%) → 진행성 충족 70% → 전진 0.3/창동의 100% · 이견 청산+재진입 · 스탑 -2.5%(ETF -5%) ·
          당일 종가 청산 · 서킷 K3M2. 227일 +120.7%p. 사다리 증액 지침 문자는 8/6 시범부터.
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
          {ssSc.slice(-5).reverse().map((s) => (
            <Row key={s.date} label={`${s.date}${s.note ? ` (${s.note})` : ""}`} value={`${pp(s.p)}${s.cut ? " 컷" : ""}`} />
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-48">
          규칙: 창(6봉 누적 순전진 1.0) 100% 진입 → 피셔F 반대 확인 시 전량 전환 → 종가 청산 · 스탑 ETF -3% ·
          F 선행일 관망 · 창 전환 무시. 232일 +112.8%p(F 0930 rebox판). 진입/전환 지침 문자는 8/6 시범부터.
        </p>
      </Card>

      <Disclaimer />
    </PageShell>
  );
}
