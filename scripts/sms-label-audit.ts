// 문자 머리말 전수조사 (사용자 지시 2026-08-08: "판정문자에 판정모델명이 빠진 경우가 있음 —
// 전수조사해서 문자에 판정모델명+판정결과가 처음에 나오도록"):
//   npx tsx scripts/sms-label-audit.ts
// lib/·app/의 모든 문자 템플릿에서 선두 대괄호 라벨과 그 뒤 첫 구절을 뽑아,
//   ①라벨에 '어느 모델인지'가 들어 있나 ②라벨 직후에 '판정 결과(방향)'가 나오나 를 점검한다.
// 판단 기준(사용자 요구): 문자를 열자마자 "무슨 모델이 무슨 판정을 냈는지"가 보여야 한다.
import { readdirSync, readFileSync, statSync } from "fs";
import { resolve, join } from "path";

type Hit = { file: string; line: number; label: string; rest: string };
const hits: Hit[] = [];

function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (/node_modules|\.next|\.git/.test(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (!/\.tsx?$/.test(name)) continue;
    const src = readFileSync(p, "utf8");
    const lines = src.split(/\r?\n/);
    lines.forEach((ln, i) => {
      // 실제 발송 문자만 — `text:` 뒤의 백틱 문자열 선두 [라벨] (console.log·개발용 로그 제외)
      const re = /text:\s*`\[([^\]]{2,40})\]([^`\n]{0,70})/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(ln))) {
        hits.push({ file: p.replace(/\\/g, "/"), line: i + 1, label: m[1], rest: m[2].replace(/\\n.*/, "").trim().slice(0, 60) });
      }
    });
  }
}
walk(resolve(process.cwd(), "lib"));
walk(resolve(process.cwd(), "app"));

// 라벨에 모델명이 들어 있는가 — 이 프로젝트가 쓰는 모델·채널 이름들
const MODEL_WORDS = /피셔|창판정|사다리|신모델|미너비니|와인스타인|돈치안|와일더|엘더|니슨|라쉬케|M7|딥바이|일봉|v2|F\b|M\b|본/;
// 라벨 직후에 방향·판정 결과가 오는가
const VERDICT_WORDS = /상승|하락|레버|인버|매수|매도|보유|진입|전환|청산|스탑|중립|관망|없음|유지|확정|경보|주의/;

const byLabel = new Map<string, Hit[]>();
for (const h of hits) {
  const k = h.label.replace(/\$\{[^}]*\}/g, "◇"); // 변수 부분 정규화
  if (!byLabel.has(k)) byLabel.set(k, []);
  byLabel.get(k)!.push(h);
}

const rows = [...byLabel.entries()].sort((a, b) => a[0].localeCompare(b[0]));
console.log(`문자 템플릿 ${hits.length}건 · 라벨 종류 ${rows.length}종\n`);
const bad: string[] = [];
console.log(`${"라벨".padEnd(30)} 건수  모델명  판정결과  위치`);
for (const [label, g] of rows) {
  // ◇ = 변수(${tierKo} 등)로 치환된 자리. 대개 모델명이 들어가므로 X가 아니라 '?'(수동 확인)로 표시한다
  // — 초판에서 이걸 X로 찍어 false positive가 다수 나왔다(2026-08-08).
  const hasVar = label.includes("◇");
  const hasModel = MODEL_WORDS.test(label);
  const hasVerdict = VERDICT_WORDS.test(label) || VERDICT_WORDS.test(g[0].rest);
  const mark = (b: boolean) => (b ? " O " : hasVar ? " ? " : " X ");
  if ((!hasModel && !hasVar) || !hasVerdict) bad.push(label);
  console.log(`${("[" + label + "]").padEnd(30)} ${String(g.length).padStart(3)}  ${mark(hasModel)}   ${mark(hasVerdict)}    ${g[0].file.split("/").slice(-2).join("/")}:${g[0].line}`);
}
console.log(`\n── 보완 대상 ${bad.length}종 (모델명 또는 판정결과가 머리말에 없음) ──`);
for (const b of bad) {
  const g = byLabel.get(b)!;
  console.log(`  [${b}] (${g.length}건) ${g[0].file.split("/").slice(-2).join("/")}:${g[0].line}`);
  console.log(`     예: [${b}]${g[0].rest}`);
}
