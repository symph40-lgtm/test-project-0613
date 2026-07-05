// SMS 발송 테스트 유틸 — `npx tsx scripts/send-test-sms.ts 01012345678`
// .env.local을 수동 로드한 뒤 lib/sms.ts(Solapi 우선)로 실발송한다. 제공사 교체·키 갱신 후 검증용.

import fs from "fs";
import path from "path";

async function main() {
  // .env.local 로드
  const envPath = path.join(process.cwd(), ".env.local");
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }

  const to = process.argv[2];
  if (!to) {
    console.error("사용법: npx tsx scripts/send-test-sms.ts 010xxxxxxxx");
    process.exit(1);
  }

  const { sendSms } = await import("../lib/sms");
  const r = await sendSms({
    to,
    text: `[스탁가드 신호] 문자 채널 테스트 (Solapi)\n판정 구간(09:30~13:30) 확정 신호가 이 번호로 발송됩니다.`,
  });
  console.log(r.ok ? "발송 성공" : `발송 실패: ${r.error}`);
  process.exit(r.ok ? 0 : 1);
}
main();
