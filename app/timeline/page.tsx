// 판정 타임라인 (사용자 지시 2026-07-25) — 대가예측모델(국·미)의 하루 전체 문자를
// 발송 순서대로 표시: 프리장 → 정규장 → 애프터장 → 일봉. alerts 이력에서 predict 계열만 추출.
// 최근 2 거래일(KST) 표시 — 새벽 미장 문자까지 한 흐름으로 보이도록.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageShell, Disclaimer } from "../_components/Shell";

export const dynamic = "force-dynamic";

const PREDICT_KEY = /^(predict_|uspredict_|pdaily_|morning_regime)/;

function tagOf(key: string): string {
  if (key.startsWith("predict_flat")) return "무추세";
  if (key.startsWith("predict_tr_")) return "전이";
  if (key.startsWith("predict_rev9")) return "반전경보";
  if (key.startsWith("predict_recut")) return "회복";
  if (key.startsWith("predict_ah") || key.startsWith("uspredict_ah")) return "애프터";
  if (key.startsWith("predict_sell")) return "청산";
  if (key.startsWith("predict_perf") || key.startsWith("pdaily_perf")) return "성능";
  if (key.startsWith("pdaily_")) return "일봉";
  if (key.startsWith("uspredict_")) return "미장";
  if (key === "morning_regime") return "레짐";
  return "예측";
}

export default async function TimelinePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();
  const kstNow = new Date(Date.now() + 9 * 3600e3);
  const twoDaysAgo = new Date(kstNow.getTime() - 2 * 86400e3).toISOString().slice(0, 10);
  const sinceUtc = new Date(`${twoDaysAgo}T00:00:00+09:00`).toISOString();
  const { data: rows } = await admin
    .from("alerts")
    .select("created_at, message, is_sent")
    .eq("user_id", user.id)
    .gte("created_at", sinceUtc)
    .order("created_at", { ascending: true })
    .limit(300);

  type Item = { kst: string; date: string; time: string; key: string; text: string; sent: boolean };
  const items: Item[] = [];
  for (const r of rows ?? []) {
    const m = r.message as { alertKey?: string; text?: string } | null;
    const key = m?.alertKey ?? "";
    if (!PREDICT_KEY.test(key)) continue;
    const kst = new Date(new Date(r.created_at as string).getTime() + 9 * 3600e3).toISOString();
    items.push({
      kst, date: kst.slice(5, 10).replace("-", "/"), time: kst.slice(11, 16),
      key, text: m?.text ?? "", sent: Boolean(r.is_sent),
    });
  }
  const byDate = new Map<string, Item[]>();
  for (const it of items) {
    const arr = byDate.get(it.date) ?? [];
    arr.push(it);
    byDate.set(it.date, arr);
  }
  const dates = [...byDate.keys()].sort().reverse();

  return (
    <PageShell title="판정 타임라인" badge="TIMELINE" width="default">
      <p className="mb-4 text-[13px] leading-relaxed text-ink-48">
        대가예측모델(국장·미장)의 판정·경보 문자를 <b>발송된 순서대로</b> 표시합니다 —
        프리장 → 정규장 → 애프터장 → 일봉. 최근 2일(KST) 기준이며 회색은 발송 억제분(취침·일시정지 — 기록만)입니다.
      </p>
      {dates.length === 0 ? (
        <p className="text-[13px] text-ink-48">최근 2일 예측 문자 없음 (휴장일 등)</p>
      ) : dates.map((d) => (
        <div key={d} className="mb-5">
          <p className="mb-2 text-[14px] font-semibold">{d}</p>
          <ol className="space-y-2 border-l-2 border-hairline pl-3">
            {byDate.get(d)!.map((it, i) => (
              <li key={i} className={`rounded-[12px] border border-hairline/60 p-3 ${it.sent ? "bg-canvas" : "bg-pearl/40 opacity-70"}`}>
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-semibold tabular-nums">{it.time}</span>
                  <span className="rounded-full bg-pearl px-2 py-0.5 text-[10.5px] font-semibold text-ink-80">{tagOf(it.key)}</span>
                  {!it.sent && <span className="text-[10.5px] text-ink-48">미발송(기록)</span>}
                </div>
                <p className="mt-1 whitespace-pre-line text-[12.5px] leading-relaxed text-ink-80">{it.text}</p>
              </li>
            ))}
          </ol>
        </div>
      ))}
      <Disclaimer />
    </PageShell>
  );
}
