// G1B 스모크 — 수집기·엔진·서비스 경로 크래시 내성 (주말 null 정상):
//   npx tsx scripts/g1b-smoke.ts
import { readFileSync } from "fs";
import { resolve } from "path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
async function main() {
  const { collectNight, collectMorning, krDaily } = await import("../lib/g1b/data");
  const { expertsR1, combine, initState, sigmaNight, dailyUpdate } = await import("../lib/g1b/engine");
  const night = await collectNight("005930");
  const morning = await collectMorning("005930");
  const kr = await krDaily("005930");
  console.log("야간:", JSON.stringify(Object.fromEntries(Object.entries(night).map(([k, o]) => [k, o.v])), null, 0));
  console.log("아침:", JSON.stringify(Object.fromEntries(Object.entries(morning).map(([k, o]) => [k, o.v])), null, 0));
  console.log("국장:", JSON.stringify(kr));
  const st = initState("005930");
  const ex = expertsR1("005930", night, st);
  const { fair, wUsed } = combine(st, ex);
  console.log("전문가:", JSON.stringify(ex), "\n결합:", fair, JSON.stringify(wUsed), "\nσ:", JSON.stringify(sigmaNight("005930", st, "normal")));
  // 합성 학습 1스텝 (실측 갭 -1.2% 가정)
  const st2 = dailyUpdate("005930", st, ex, fair, -1.2, "normal", night);
  console.log("학습 후 Hedge:", JSON.stringify(st2.hedge_w), "bias:", st2.bias.toFixed(3), "cusum:", st2.cusum.toFixed(2));
  const { runG1BService } = await import("../lib/g1b/service");
  console.log("서비스:", JSON.stringify(await runG1BService()));
}
main();
