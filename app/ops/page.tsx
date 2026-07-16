// 운영 설정·지시 (사용자 지정 2026-07-16) — 모바일에서 문자 정책을 즉시 제어하고,
// 프로그램 변경 지시를 남기면 다음 Claude 작업 세션에서 반영하는 창구.
// ①즉시 적용: 문자 일시정지 (서버가 60초 내 반영) ②지시 저장함: pending → Claude가 적용 후 applied.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageShell, Disclaimer } from "../_components/Shell";
import { setSmsPause, clearSmsPause, addDirective } from "./actions";

export const dynamic = "force-dynamic";

export default async function OpsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();
  const [{ data: pauseRow }, { data: directives }] = await Promise.all([
    admin.from("ops_settings").select("value, updated_at").eq("key", "sms_pause").maybeSingle(),
    admin.from("ops_directives").select("id, created_at, content, status, note").eq("user_id", user.id).order("created_at", { ascending: false }).limit(20),
  ]);
  const pause = (pauseRow?.value ?? null) as { until?: string; allowStrong?: boolean } | null;
  const kstToday = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const pauseActive = pause?.until != null && kstToday <= pause.until;

  const STATUS_STYLE: Record<string, string> = {
    pending: "bg-amber-50 text-amber-700",
    applied: "bg-green-50 text-green-700",
    rejected: "bg-red-50 text-red-600",
  };

  return (
    <PageShell title="운영 설정 · 지시" badge="OPS" width="default">
      <p className="mb-4 text-[13px] leading-relaxed text-ink-48">
        문자 정책을 즉시 제어하거나, 프로그램 변경 지시를 남기는 창구입니다.
        일시정지는 <b>1분 내</b> 발송 서버에 반영되고, 자유 지시는 다음 Claude 작업 세션에서 코드로 반영됩니다.
      </p>

      {/* ① 문자 일시정지 — 즉시 적용 */}
      <div className="mb-4 rounded-[18px] border border-hairline bg-canvas p-5">
        <p className="mb-1 text-[14px] font-semibold">문자 일시정지 (즉시 적용)</p>
        <p className="mb-3 text-[12px] text-ink-48">
          현재 상태: {pauseActive
            ? <b className="text-red-600">{pause!.until}까지 정지 중{pause?.allowStrong !== false ? " (판정 확정 문자는 허용)" : " (전체 정지)"}</b>
            : "정상 발송 중"}
          {" · "}7/17~18은 코드 차원에서도 정지 예약됨 (판정 문자만 예외)
        </p>
        <form action={setSmsPause} className="flex flex-wrap items-center gap-2">
          <input type="date" name="until" defaultValue={pause?.until ?? kstToday} required
            className="rounded-[8px] border border-hairline bg-canvas px-3 py-1.5 text-[13px]" />
          <label className="flex items-center gap-1.5 text-[13px] text-ink-80">
            <input type="checkbox" name="allowStrong" defaultChecked={pause?.allowStrong !== false} />
            판정 확정 문자는 허용
          </label>
          <button type="submit" className="rounded-[8px] bg-ink px-4 py-1.5 text-[13px] font-semibold text-white">이 날짜까지 정지</button>
        </form>
        {pauseActive ? (
          <form action={clearSmsPause} className="mt-2">
            <button type="submit" className="rounded-[8px] border border-hairline px-4 py-1.5 text-[13px] hover:bg-pearl">정지 해제 (즉시 재개)</button>
          </form>
        ) : null}
      </div>

      {/* ② 자유 지시 — 다음 세션 반영 */}
      <div className="mb-4 rounded-[18px] border border-hairline bg-canvas p-5">
        <p className="mb-1 text-[14px] font-semibold">프로그램 변경 지시</p>
        <p className="mb-3 text-[12px] text-ink-48">
          예: &quot;어떤 조건일 때 문자 보내줘&quot;, &quot;임계값 바꿔줘&quot;, &quot;이 문자 없애줘&quot; — 저장해두면
          다음 Claude 작업 세션에서 읽고 코드에 반영한 뒤 상태를 갱신합니다.
        </p>
        <form action={addDirective} className="space-y-2">
          <textarea name="content" rows={3} required placeholder="지시 내용을 적어주세요"
            className="w-full rounded-[12px] border border-hairline bg-canvas p-3 text-[14px]" />
          <button type="submit" className="rounded-[8px] bg-guard px-4 py-1.5 text-[13px] font-semibold text-white">지시 남기기</button>
        </form>
      </div>

      {/* 지시 이력 */}
      <div className="rounded-[18px] border border-hairline bg-canvas p-5">
        <p className="mb-2 text-[14px] font-semibold">지시 이력</p>
        {(directives ?? []).length === 0 ? (
          <p className="text-[13px] text-ink-48">아직 없음</p>
        ) : (
          <ul className="space-y-2">
            {(directives ?? []).map((d) => (
              <li key={d.id} className="border-b border-hairline/40 pb-2 text-[13px] last:border-b-0">
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[d.status] ?? "bg-pearl text-ink-48"}`}>{d.status}</span>
                  <span className="text-[11px] text-ink-48">{new Date(new Date(d.created_at).getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ")}</span>
                </div>
                <p className="mt-1 whitespace-pre-line text-ink-80">{d.content}</p>
                {d.note ? <p className="mt-0.5 text-[12px] text-ink-48">↳ {d.note}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Disclaimer />
    </PageShell>
  );
}
