// 이메일 발송 유틸리티
// RESEND_API_KEY 환경변수가 설정된 경우 Resend API를 사용, 없으면 console.log fallback

export async function sendEmail({
  to,
  subject,
  text,
}: {
  to: string;
  subject: string;
  text: string;
}): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.log(
      `[DEV EMAIL]\nTo: ${to}\nSubject: ${subject}\n\n${text}\n`,
    );
    return { ok: true };
  }

  try {
    const from = process.env.EMAIL_FROM ?? "noreply@resend.dev";
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, text }),
    });

    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `이메일 발송 실패: ${body}` };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "알 수 없는 오류" };
  }
}
