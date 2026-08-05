// 대가 모델 분야별(레버/인버/무추세) 전문화 분석 — 피셔 대체·보완 가능성 (사용자 질문 8/6)
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
const KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
type V = "leverage" | "inverse" | "none";
type MRow = { date: string; model: string; verdict: V; label: V | null };
type DRow = { date: string; r_oc: number | null; label: V | null };

async function all<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${URL}${path}&limit=1000&offset=${off}`, { headers: H }).then((x) => x.json());
    out.push(...(r as T[]));
    if ((r as T[]).length < 1000) break;
  }
  return out;
}
const K: Record<V, string> = { leverage: "레버리지", inverse: "인버스", none: "무추세" };

async function main() {
  const mrows = await all<MRow>("/rest/v1/predict_model_days?select=date,model,verdict,label&order=date.asc");
  const drows = await all<DRow>("/rest/v1/predict_days?select=date,r_oc,label&order=date.asc");
  const dBy = new Map(drows.map((d) => [d.date, d]));
  const byModel = new Map<string, MRow[]>();
  for (const r of mrows) {
    if (!r.label) continue;
    const a = byModel.get(r.model) ?? [];
    a.push(r); byModel.set(r.model, a);
  }
  const models = [...byModel.keys()];
  console.log(`기간 ${mrows[0]?.date} ~ ${mrows[mrows.length - 1]?.date} · 모델: ${models.join(", ")}`);

  // ① 분야별 정밀도 (판정 c일 때 실제 c 비율) + 커버(판정 횟수)
  console.log("\n════ ① 분야별 정밀도 — 판정한 날 중 맞춘 비율 (판정 수) ════");
  for (const m of models) {
    const rows = byModel.get(m)!;
    const parts: string[] = [];
    for (const c of ["leverage", "inverse", "none"] as V[]) {
      const p = rows.filter((r) => r.verdict === c);
      const hit = p.filter((r) => r.label === c).length;
      parts.push(`${K[c]} ${p.length ? Math.round((100 * hit) / p.length) : 0}% (${p.length})`);
    }
    const acc = Math.round((100 * rows.filter((r) => r.verdict === r.label).length) / rows.length);
    console.log(`${m.padEnd(8)}: ${parts.join(" · ")} · 전체 ${acc}%/${rows.length}일`);
  }

  // ② 방향일 손익 프록시 — 판정 방향 × 당일 r_oc (시가→종가), none은 0
  console.log("\n════ ② 손익 프록시 (판정 방향 × 시가→종가 %, 무추세=0) ════");
  const pnlOf = (rows: MRow[]): number => {
    let s = 0;
    for (const r of rows) {
      const d = dBy.get(r.date);
      if (!d || d.r_oc === null) continue;
      if (r.verdict === "leverage") s += d.r_oc;
      else if (r.verdict === "inverse") s -= d.r_oc;
    }
    return s;
  };
  for (const m of models) console.log(`${m.padEnd(8)}: ${pnlOf(byModel.get(m)!).toFixed(1)}%p`);

  // ③ 보완(동의 필터): 피셔 판정 c에서 모델 M 동의 여부로 조건화한 정밀도
  const fisher = byModel.get("fisher") ?? [];
  const fBy = new Map(fisher.map((r) => [r.date, r]));
  console.log("\n════ ③ 피셔 판정을 다른 모델 동의로 조건화 (동의 시 정밀도 / 반대·무동의 시) ════");
  for (const m of models.filter((x) => x !== "fisher")) {
    const mb = new Map(byModel.get(m)!.map((r) => [r.date, r]));
    for (const c of ["leverage", "inverse", "none"] as V[]) {
      const days = fisher.filter((r) => r.verdict === c && mb.has(r.date));
      const agree = days.filter((r) => mb.get(r.date)!.verdict === c);
      const dis = days.filter((r) => mb.get(r.date)!.verdict !== c);
      const acc = (a: MRow[]) => (a.length ? Math.round((100 * a.filter((r) => r.label === c).length) / a.length) : null);
      const aA = acc(agree), aD = acc(dis);
      if (agree.length >= 15 && aA !== null && aD !== null && Math.abs(aA - aD) >= 10)
        console.log(`피셔 ${K[c]} × ${m} 동의: ${aA}% (${agree.length}) vs 비동의 ${aD}% (${dis.length})  ← 격차 ${aA - aD}`);
    }
  }

  // ④ 분야 전문가 대체: "M이 c 판정하면 c 채택, 아니면 피셔" — 전체 3분류 적중·손익 프록시 변화
  console.log("\n════ ④ 분야 전문가 대체 하이브리드 (M이 c 판정 시 우선) — 피셔 대비 변화 ════");
  const fAcc = Math.round((100 * fisher.filter((r) => r.verdict === r.label).length) / fisher.length);
  const fPnl = pnlOf(fisher);
  console.log(`피셔 기준: 3분류 ${fAcc}% · 손익 ${fPnl.toFixed(1)}%p`);
  for (const m of models.filter((x) => x !== "fisher")) {
    const mb = new Map(byModel.get(m)!.map((r) => [r.date, r]));
    for (const c of ["leverage", "inverse", "none"] as V[]) {
      const hybrid: MRow[] = fisher.map((f) => {
        const mr = mb.get(f.date);
        return mr && mr.verdict === c ? { ...f, verdict: c } : f;
      });
      const hAcc = Math.round((100 * hybrid.filter((r) => r.verdict === r.label).length) / hybrid.length);
      const hPnl = pnlOf(hybrid);
      const changed = fisher.filter((f) => { const mr = mb.get(f.date); return mr && mr.verdict === c && f.verdict !== c; }).length;
      if (hPnl - fPnl >= 5 || hAcc - fAcc >= 2)
        console.log(`${m} → ${K[c]} 우선 (변경 ${changed}일): 3분류 ${hAcc}% (${hAcc - fAcc >= 0 ? "+" : ""}${hAcc - fAcc}) · 손익 ${hPnl.toFixed(1)}%p (${hPnl - fPnl >= 0 ? "+" : ""}${(hPnl - fPnl).toFixed(1)})`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
