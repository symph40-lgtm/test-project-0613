// SMS 발송 유틸리티 — Solapi(쿨SMS) 우선, 알리고 폴백, 둘 다 없으면 console.log (개발 모드)
//
// Solapi (권장 — 2026-07-05 교체): API Key + Secret HMAC 서명 인증이라 발송 IP 등록이 필요 없음.
//   알리고는 발송 IP 사전등록제라 유동 IP인 Vercel 서버에서 인증오류(-101)로 발송 불가했음.
//   필요 env: SOLAPI_API_KEY / SOLAPI_API_SECRET / SOLAPI_SENDER (콘솔에 사전 등록된 발신번호)
// Aligo (폴백): ALIGO_API_KEY / ALIGO_USER_ID / ALIGO_SENDER — 고정 IP 서버에서만 유효.

import crypto from "crypto";

export function hasSmsProvider(): boolean {
  return hasSolapi() || hasAligo();
}

function hasSolapi(): boolean {
  return Boolean(process.env.SOLAPI_API_KEY && process.env.SOLAPI_API_SECRET && process.env.SOLAPI_SENDER);
}

function hasAligo(): boolean {
  return Boolean(process.env.ALIGO_API_KEY && process.env.ALIGO_USER_ID && process.env.ALIGO_SENDER);
}

// 한국 휴대폰 번호 정규화: 하이픈/공백 제거, 010xxxxxxxx 형태
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (/^01[016789]\d{7,8}$/.test(digits)) return digits;
  return null;
}

// EUC-KR 근사 바이트 (한글 2바이트) — 90바이트 초과면 LMS
function krByteLength(s: string): number {
  let n = 0;
  for (const ch of s) n += ch.charCodeAt(0) <= 0x7f ? 1 : 2;
  return n;
}

// 제목(subject) 정책 (사용자 확정 2026-07-08): 본문이 90바이트 이하 단문이면 제목을 무시하고
// 무제 SMS로 발송한다 — 제목을 붙이면 무조건 LMS(장문 요금)로 전환되기 때문.
// 제목은 본문이 90바이트를 넘어 어차피 LMS가 되는 경우에만 붙는다.
export async function sendSms({
  to,
  text,
  subject,
}: {
  to: string;
  text: string;
  subject?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const phone = normalizePhone(to);
  if (!phone) {
    return { ok: false, error: "유효한 휴대폰 번호가 아닙니다." };
  }

  if (hasSolapi()) return sendViaSolapi(phone, text, subject);
  if (hasAligo()) return sendViaAligo(phone, text, subject);

  console.log(`[DEV SMS]\nTo: ${phone}${subject ? `\nSubject: ${subject}` : ""}\n\n${text}\n`);
  return { ok: true };
}

// ── Solapi v4 — HMAC-SHA256 서명 인증
async function sendViaSolapi(phone: string, text: string, subject?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const apiKey = process.env.SOLAPI_API_KEY!;
    const apiSecret = process.env.SOLAPI_API_SECRET!;
    const sender = normalizePhone(process.env.SOLAPI_SENDER!) ?? process.env.SOLAPI_SENDER!;

    const date = new Date().toISOString();
    const salt = crypto.randomBytes(16).toString("hex");
    const signature = crypto.createHmac("sha256", apiSecret).update(date + salt).digest("hex");

    // 단문(≤90바이트)은 제목을 버리고 SMS 발송 — 장문일 때만 제목 포함 LMS (사용자 확정 2026-07-08)
    const isLms = krByteLength(text) > 90;
    if (!isLms) subject = undefined;
    const res = await fetch("https://api.solapi.com/messages/v4/send", {
      method: "POST",
      headers: {
        Authorization: `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          to: phone,
          from: sender,
          text,
          type: isLms ? "LMS" : "SMS",
          ...(subject ? { subject } : {}), // 제목은 요청된 알림 종류만 (미지정 시 무제)
        },
      }),
    });

    const body = (await res.json().catch(() => ({}))) as { statusCode?: string; statusMessage?: string; errorCode?: string; errorMessage?: string };
    // 성공: HTTP 200 + groupId 반환. 실패: errorCode/errorMessage 또는 4xx
    if (res.ok && !body.errorCode) return { ok: true };
    return { ok: false, error: `Solapi 발송 실패: ${body.errorMessage ?? body.statusMessage ?? `HTTP ${res.status}`}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "알 수 없는 오류" };
  }
}

// ── Aligo (레거시 폴백 — 등록 IP에서만 동작)
async function sendViaAligo(phone: string, text: string, subject?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    // 단문(≤90바이트)은 제목을 버리고 SMS 발송 — 장문일 때만 제목 포함 LMS (사용자 확정 2026-07-08)
    const isLms = krByteLength(text) > 90;
    if (!isLms) subject = undefined;
    const body = new URLSearchParams({
      key: process.env.ALIGO_API_KEY!,
      user_id: process.env.ALIGO_USER_ID!,
      sender: process.env.ALIGO_SENDER!,
      receiver: phone,
      msg: text,
      msg_type: isLms ? "LMS" : "SMS",
      ...(subject ? { title: subject } : {}),
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
