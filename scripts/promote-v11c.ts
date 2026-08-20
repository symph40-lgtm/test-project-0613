// v1.1c 승격 전환 스크립트 — 발주자 승인 후 1회 실행 (playbook: g1br/promotion_playbook_v11c.md)
//   npx tsx scripts/promote-v11c.ts --r1 [--symbol 000660]   R1 챔피언 교체 (가중 이관 + promo_v11c 마커)
//   npx tsx scripts/promote-v11c.ts --r2 [--symbol 000660]   R2 이론가 교체 (promo_r2_v11c 마커)
//   npx tsx scripts/promote-v11c.ts --status                 현재 승격 상태만 출력
// 실행 창: 판정 창 밖(라벨 창 이후 ~ 다음 R1 전) 권장. 되돌림은 g1b_state_snapshots 당일 스냅샷으로.
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { createClient } from "@supabase/supabase-js";

type St = {
  hedge_w: Record<string, number>;
  challenger_v11c?: { hedge_w: Record<string, number>; nights: number };
  promo_v11c?: { at: string };
  promo_r2_v11c?: { at: string };
};

async function main() {
  const args = process.argv.slice(2);
  const doR1 = args.includes("--r1"), doR2 = args.includes("--r2"), statusOnly = args.includes("--status");
  const symArg = args[args.indexOf("--symbol") + 1];
  const symbols = args.includes("--symbol") ? [symArg] : ["005930", "000660"];
  if (!statusOnly && !doR1 && !doR2) { console.log("사용법: --r1 | --r2 | --status [--symbol 종목코드]"); return; }

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

  for (const symbol of symbols) {
    const { data, error } = await sb.from("g1b_state").select("state").eq("symbol", symbol).maybeSingle();
    if (error || !data) { console.log(`${symbol}: 상태 로드 실패 — ${error?.message ?? "행 없음"}`); continue; }
    const st = data.state as St;
    console.log(`\n[${symbol}] 현재: promo_v11c ${st.promo_v11c?.at ?? "없음"} · promo_r2_v11c ${st.promo_r2_v11c?.at ?? "없음"} · v1.1c 섀도 ${st.challenger_v11c?.nights ?? 0}밤`);
    console.log(`  챔피언 가중: ${JSON.stringify(st.hedge_w)}`);
    console.log(`  v1.1c 가중: ${JSON.stringify(st.challenger_v11c?.hedge_w ?? null)}`);
    if (statusOnly) continue;

    if (doR1) {
      if (st.promo_v11c) { console.log(`  --r1 건너뜀: 이미 승격됨 (${st.promo_v11c.at})`); }
      else if (!st.challenger_v11c?.hedge_w?.nf) { console.log(`  --r1 중단: challenger_v11c 가중에 nf 없음 — 이관 불가`); }
      else {
        st.hedge_w = { ...st.challenger_v11c.hedge_w };   // 가중 이관 (nf 포함 — 학습된 발언권 그대로)
        st.promo_v11c = { at: today };
        console.log(`  → R1 승격: 가중 이관 완료, promo_v11c=${today} (challenger 기록은 동결 보존)`);
      }
    }
    if (doR2) {
      if (st.promo_r2_v11c) { console.log(`  --r2 건너뜀: 이미 교체됨 (${st.promo_r2_v11c.at})`); }
      else { st.promo_r2_v11c = { at: today }; console.log(`  → R2 이론가 교체: promo_r2_v11c=${today}`); }
    }
    const { error: e2 } = await sb.from("g1b_state").upsert({ symbol, state: st, updated_at: new Date().toISOString() });
    console.log(e2 ? `  저장 실패: ${e2.message}` : `  저장 완료`);
  }
}
main();
