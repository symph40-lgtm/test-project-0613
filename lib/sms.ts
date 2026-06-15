// SMS 발송 유틸리티 (Aligo)
// ALIGO_API_KEY / ALIGO_USER_ID / ALIGO_SENDER 환경변수가 모두 설정된 경우 Aligo API 사용,
// 하나라도 없으면 console.log fallback (개발 모드)
//
// 발송 전 Aligo 콘솔에서 발신번호 사전등록이 완료되어 있어야 합니다.
// https://smartsms.aligo.in/

export function hasSmsProvider(): boolean {
  return Boolean(
    process.env.ALIGO_API_KEY &&
      process.env.ALIGO_USER_ID &&
      process.env.ALIGO_SENDER,
  );
}

// 한국 휴대폰 번호 정규화: 하이픈/공백 제거, 010xxxxxxxx 형태
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (/^01[016789]\d{7,8}$/.test(digits)) return digits;
  return null;
}

export async function sendSms({
  to,
  text,
}: {
  to: string;
  text: string;
}): Promise<{ ok: boolean; error?: string }> {
  const phone = normalizePhone(to);
  if (!phone) {
    return { ok: false, error: "유효한 휴대폰 번호가 아닙니다." };
  }

  if (!hasSmsProvider()) {
    console.log(`[DEV SMS]\nTo: ${phone}\n\n${text}\n`);
    return { ok: true };
  }

  try {
    const body = new URLSearchParams({
      key: process.env.ALIGO_API_KEY!,
      user_id: process.env.ALIGO_USER_ID!,
      sender: process.env.ALIGO_SENDER!,
      receiver: phone,
      msg: text,
      // 90byte 초과 시 자동으로 LMS 전환
      msg_type: text.length > 45 ? "LMS" : "SMS",
      title: "스탁가드 알림",
    });

    const res = await fetch("https://apis.aligo.in/send/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const data = (await res.json()) as { result_code: number | string; message?: string };

    // Aligo: result_code "1" (또는 1) = 성공
    if (String(data.result_code) === "1") {
      return { ok: true };
    }
    return { ok: false, error: `SMS 발송 실패: ${data.message ?? "알 수 없는 오류"}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "알 수 없는 오류" };
  }
}
