import type { ReactNode } from "react";

/* 결정 타일 — 라이트/패치먼트/다크 풀폭 섹션 */
export function Tile({
  tone = "light",
  children,
  className = "",
}: {
  tone?: "light" | "parchment" | "dark";
  children: ReactNode;
  className?: string;
}) {
  const toneClass =
    tone === "dark"
      ? "bg-tile-1 text-white"
      : tone === "parchment"
        ? "bg-parchment text-ink"
        : "bg-canvas text-ink";
  return (
    <section className={`px-6 py-8 sm:px-10 sm:py-10 ${toneClass} ${className}`}>
      {children}
    </section>
  );
}

/* 유틸리티 카드 — 1px 헤어라인, 18px radius */
export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-[18px] border border-hairline bg-canvas p-6 ${className}`}
    >
      {children}
    </div>
  );
}

/* 질적 라벨 배지 — 색만이 아니라 텍스트로 위험도를 전달 */
export function RiskBadge({ level }: { level: "취약" | "높음" | "주의" | "안정" | string }) {
  const tone =
    level === "취약" || level === "높음"
      ? "bg-ink text-white"
      : level === "주의"
        ? "bg-ink/10 text-ink"
        : "bg-pearl text-ink-80 border border-hairline";
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-[12px] ${tone}`}>
      {level}
    </span>
  );
}

/* 위험 점수 바 — 0~100, 모노톤 (단일 액센트 원칙 유지) */
export function ScoreBar({
  label,
  score,
  note,
}: {
  label: string;
  score: number;
  note: string;
}) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="w-24 shrink-0 text-[15px]">{label}</span>
      <span className="w-8 shrink-0 text-right text-[15px] font-semibold tabular-nums">
        {score}
      </span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-divider">
        <div
          className="h-full rounded-full bg-ink"
          style={{ width: `${Math.min(100, Math.max(0, score))}%` }}
        />
      </div>
      <span className="w-40 shrink-0 text-right text-[13px] text-ink-48">{note}</span>
    </div>
  );
}

/* 라벨이 붙은 행동/금지 리스트 */
export function ActionList({
  title,
  items,
  tone = "do",
}: {
  title: string;
  items: string[];
  tone?: "do" | "dont";
}) {
  return (
    <div>
      <h3 className="text-[14px] font-semibold tracking-[-0.224px] text-ink-48">{title}</h3>
      <ul className="mt-2 space-y-1.5">
        {items.map((it) => (
          <li key={it} className="flex gap-2 text-[17px] leading-snug">
            <span aria-hidden className="select-none text-ink-48">
              {tone === "do" ? "·" : "×"}
            </span>
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* 섹션 라벨 */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-3 text-[14px] font-semibold uppercase tracking-[0.04em] text-ink-48">
      {children}
    </h2>
  );
}

/* 키-값 행 */
export function MetaRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-[14px] text-ink-48">{label}</span>
      <span className="text-right text-[15px]">{value}</span>
    </div>
  );
}

/* 입력 필드 (목업 — 비제어, 시각 표현용) */
export function Field({
  label,
  placeholder,
  defaultValue,
  required,
  type = "text",
  hint,
}: {
  label: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  type?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1 text-[14px] text-ink-80">
        {label}
        {required ? <span className="text-guard">*</span> : null}
      </span>
      <input
        type={type}
        placeholder={placeholder}
        defaultValue={defaultValue}
        className="h-11 w-full rounded-[8px] border border-hairline bg-canvas px-3.5 text-[16px] outline-none placeholder:text-ink-48 focus:border-guard"
      />
      {hint ? <span className="mt-1 block text-[12px] text-ink-48">{hint}</span> : null}
    </label>
  );
}

/* 빈/로딩/오류 상태 박스 */
export function StateNote({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "error";
  title: string;
  children?: ReactNode;
}) {
  const cls =
    tone === "error"
      ? "border-ink/20 bg-pearl"
      : "border-hairline bg-pearl";
  return (
    <div className={`rounded-[11px] border ${cls} p-4`}>
      <p className="text-[15px] font-semibold">{title}</p>
      {children ? <p className="mt-1 text-[14px] text-ink-48">{children}</p> : null}
    </div>
  );
}
