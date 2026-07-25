// 피셔 판정 실시간 (사용자 지시 2026-07-25 — /ops 내 섹션에서 독립 페이지로 승격):
// 하닉·삼전·SOXX 버튼 문의 + 시장별 최근 결과를 나란히 표시 (ops_settings.fisher_now_{hx|ss|us}).
// 국장은 15:30 이후 문의 시 NXT 애프터장 실시간 판정으로 응답. 문의 시 문자 요약도 즉시 발송.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageShell, Disclaimer } from "../_components/Shell";
import { queryFisherNow } from "../ops/actions";
import type { FisherNow } from "@/lib/predict/nowcast";

export const dynamic = "force-dynamic";

const MARKETS = [
  { key: "hx", label: "하닉", settings: "fisher_now_hx" },
  { key: "ss", label: "삼전", settings: "fisher_now_ss" },
  { key: "us", label: "SOXX", settings: "fisher_now_us" },
] as const;

export default async function FisherPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("ops_settings")
    .select("key, value, updated_at")
    .in("key", MARKETS.map((m) => m.settings));
  const byKey = new Map((rows ?? []).map((r) => [r.key as string, r]));

  return (
    <PageShell title="피셔 판정 실시간" badge="FISHER" width="default">
      <p className="mb-4 text-[13px] leading-relaxed text-ink-48">
        지금 시점의 피셔F → 피셔M → 본피셔 판정을 즉시 계산해 아래에 표시하고, 핵심 요약을
        <b> 문자로 바로</b> 보냅니다. 국장(하닉·삼전)은 15:30 이후 문의 시 NXT <b>애프터장 실시간
        판정</b>으로 응답합니다. (SOXX = 미장 기준)
      </p>

      <div className="mb-4 flex flex-wrap gap-2">
        {MARKETS.map((m) => (
          <form key={m.key} action={queryFisherNow}>
            <input type="hidden" name="market" value={m.key} />
            <button type="submit" className="rounded-[8px] bg-ink px-5 py-2 text-[14px] font-semibold text-white">
              {m.label}
            </button>
          </form>
        ))}
      </div>

      {MARKETS.map((m) => {
        const row = byKey.get(m.settings);
        const last = (row?.value ?? null) as FisherNow | null;
        return (
          <div key={m.key} className="mb-4 rounded-[18px] border border-hairline bg-canvas p-5">
            <p className="mb-1 text-[14px] font-semibold">{m.label}</p>
            {last ? (
              <div className="rounded-[12px] bg-pearl/60 p-4">
                <p className="text-[13px] font-semibold">
                  {last.title} <span className="font-normal text-ink-48">· {last.asOf} 조회</span>
                </p>
                <ul className="mt-2 space-y-1">
                  {last.detail.map((line, i) => (
                    <li key={i} className="text-[12.5px] leading-relaxed text-ink-80">{line}</li>
                  ))}
                </ul>
                <p className="mt-3 border-t border-hairline/50 pt-2 text-[12px] text-ink-48 whitespace-pre-line">
                  문자 발송분: {last.summary}
                </p>
              </div>
            ) : (
              <p className="text-[12px] text-ink-48">아직 조회 이력 없음 — 위 {m.label} 버튼을 누르면 여기 표시됩니다.</p>
            )}
          </div>
        );
      })}

      <Disclaimer />
    </PageShell>
  );
}
