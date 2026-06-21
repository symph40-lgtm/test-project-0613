"use client";

import { useState, useTransition } from "react";
import { Sparkles, Trash2, ChevronDown, ChevronUp, Gauge } from "lucide-react";
import { Button } from "../_components/Button";
import { Card, SectionLabel } from "../_components/primitives";
import { askExperts, getConsultHistory, setReflect, deleteConsult, generateStance, type ConsultRow } from "./actions";
import { STANCE7_META, type Stance7, type AnswerStance } from "@/lib/market/stance";

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// 한 AI의 답변 패널
function AnswerPanel({
  source, model, text, error,
}: { source: string; model: string | null; text: string | null; error?: string | null }) {
  return (
    <div className="rounded-[12px] border border-hairline bg-pearl p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[14px] font-semibold">{source}</span>
        {model && <span className="rounded bg-ink/8 px-1.5 py-0.5 text-[11px] text-ink-48">{model}</span>}
      </div>
      {text ? (
        <p className="mt-2 whitespace-pre-wrap text-[14px] leading-relaxed text-ink-80">{text}</p>
      ) : (
        <p className="mt-2 text-[13px] text-ink-48">{error ?? "답변을 받지 못했습니다."}</p>
      )}
    </div>
  );
}

// 7단계 스탠스 배지
function StanceBadge({ stance }: { stance: Stance7 }) {
  const m = STANCE7_META[stance];
  const cls = m.tone === "buy" ? "bg-red-50 text-red-600" : m.tone === "sell" ? "bg-blue-50 text-blue-600" : "bg-ink/10 text-ink-80";
  return <span className={`rounded-full px-2 py-0.5 text-[12px] font-semibold ${cls}`}>{stance}. {m.label}</span>;
}

function FactorList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-1.5">
      <p className="text-[12px] font-semibold text-ink-48">{title}</p>
      <ul className="mt-0.5 space-y-0.5">
        {items.map((it, i) => (
          <li key={i} className="flex gap-1.5 text-[13px] leading-snug text-ink-80"><span className="text-ink-48">·</span>{it}</li>
        ))}
      </ul>
    </div>
  );
}

// AI 답변 → 7단계 매매·위험도 판단 카드
function StanceCard({ s }: { s: AnswerStance }) {
  return (
    <div className="mt-3 rounded-[10px] border border-hairline bg-canvas p-3">
      <div className="flex items-center gap-2">
        <StanceBadge stance={s.overall.stance} />
        <span className="text-[12px] text-ink-48">위험도 {s.overall.risk}</span>
      </div>
      {s.overall.summary && <p className="mt-1.5 text-[14px] leading-snug text-ink-80">{s.overall.summary}</p>}
      <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
        <FactorList title="강세 요인" items={s.overall.bull} />
        <FactorList title="약세 요인" items={s.overall.bear} />
      </div>
      <FactorList title="핵심 리스크" items={s.overall.risks} />
      {s.tickers.length > 0 && (
        <div className="mt-2">
          <p className="text-[12px] font-semibold text-ink-48">종목별 스탠스</p>
          <ul className="mt-1 space-y-1">
            {s.tickers.map((t, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 text-[13px]">
                <StanceBadge stance={t.stance} />
                <span className="font-medium">{t.ticker}</span>
                <span className="text-ink-48">{t.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-2 text-[11px] leading-snug text-ink-48">
        AI 의견 기반 ‘신호 등급’이며 명령·투자권유가 아닙니다. ‘시황 반영’을 켜면 장중 종목별 매매 판단에 ±2 한정으로만 반영됩니다.
      </p>
    </div>
  );
}

function HistoryItem({
  row, onToggle, onDelete,
}: { row: ConsultRow; onToggle: (id: string, on: boolean) => void; onDelete: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [stance, setStance] = useState<AnswerStance | null>(row.stance);
  const [genPending, startGen] = useTransition();

  function gen() {
    startGen(async () => {
      const s = await generateStance(row.id);
      if (s) setStance(s);
    });
  }

  return (
    <div className="border-b border-divider py-3 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <button onClick={() => setOpen((v) => !v)} className="flex flex-1 items-start gap-2 text-left">
          {open ? <ChevronUp size={16} className="mt-0.5 shrink-0 text-ink-48" /> : <ChevronDown size={16} className="mt-0.5 shrink-0 text-ink-48" />}
          <span>
            <span className="text-[15px] font-medium leading-snug">{row.question}</span>
            <span className="mt-0.5 block text-[12px] text-ink-48">{fmtTime(row.created_at)}</span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1 text-[12px] text-ink-48">
            <input
              type="checkbox"
              checked={row.reflect}
              onChange={(e) => onToggle(row.id, e.target.checked)}
              className="accent-guard"
            />
            시황 반영
          </label>
          <button onClick={() => onDelete(row.id)} className="text-ink-48 hover:text-guard" aria-label="삭제">
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3 pl-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <AnswerPanel source="ChatGPT (OpenAI)" model={row.openai_model} text={row.openai_answer} />
            <AnswerPanel source="Claude" model={row.claude_model} text={row.claude_answer} />
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Button variant="secondary" onClick={gen} disabled={genPending} className="!px-3.5 !py-2 !text-[13px]">
              <Gauge size={14} />
              {genPending ? "분석 중…" : stance ? "10단계 판단 다시 생성" : "10단계 매매·위험도 판단 생성"}
            </Button>
            {!stance && <span className="text-[12px] text-ink-48">이 답변을 10단계 스탠스로 정리합니다</span>}
          </div>
          {stance && <StanceCard s={stance} />}
        </div>
      )}
    </div>
  );
}

export default function ConsultClient({ initialHistory }: { initialHistory: ConsultRow[] }) {
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<ConsultRow[]>(initialHistory);
  const [current, setCurrent] = useState<{
    question: string;
    openai: { text: string | null; model: string | null; error: string | null };
    claude: { text: string | null; model: string | null; error: string | null };
  } | null>(null);
  const [isPending, startTransition] = useTransition();

  function ask() {
    const q = question.trim();
    if (!q) return;
    startTransition(async () => {
      const r = await askExperts(q);
      setCurrent({
        question: r.question,
        openai: { text: r.openai?.text ?? null, model: r.openai?.model ?? null, error: r.openaiError },
        claude: { text: r.claude?.text ?? null, model: r.claude?.model ?? null, error: r.claudeError },
      });
      // 저장된 경우 이력 갱신
      if (r.id) {
        const fresh = await getConsultHistory(20);
        setHistory(fresh);
      }
      setQuestion("");
    });
  }

  function onToggle(id: string, on: boolean) {
    setHistory((h) => h.map((r) => (r.id === id ? { ...r, reflect: on } : r)));
    startTransition(async () => {
      await setReflect(id, on);
    });
  }

  function onDelete(id: string) {
    setHistory((h) => h.filter((r) => r.id !== id));
    startTransition(async () => {
      await deleteConsult(id);
    });
  }

  return (
    <div className="mt-6">
      {/* 질문 입력 */}
      <Card>
        <SectionLabel>질문하기</SectionLabel>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask();
          }}
          placeholder="예: 지금 반도체 업황에서 SK하이닉스 비중을 어떻게 보는 게 좋을까요? 금리 인하기에 성장주 대응 원칙은?"
          rows={3}
          className="w-full resize-y rounded-[10px] border border-hairline bg-canvas px-3.5 py-3 text-[15px] leading-relaxed outline-none placeholder:text-ink-48 focus:border-guard"
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[12px] text-ink-48">⌘/Ctrl + Enter 로 전송 · 두 AI가 동시에 답합니다</span>
          <Button variant="primary" onClick={ask} disabled={isPending || !question.trim()} className="!px-5 !py-2.5 !text-[15px] shrink-0">
            <Sparkles size={15} />
            {isPending ? "물어보는 중…" : "두 AI에게 물어보기"}
          </Button>
        </div>
      </Card>

      {/* 현재 답변 */}
      {current && (
        <Card className="mt-4">
          <SectionLabel>답변 비교</SectionLabel>
          <p className="mb-3 text-[15px] font-medium">{current.question}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <AnswerPanel source="ChatGPT (OpenAI)" model={current.openai.model} text={current.openai.text} error={current.openai.error} />
            <AnswerPanel source="Claude" model={current.claude.model} text={current.claude.text} error={current.claude.error} />
          </div>
          <p className="mt-3 text-[12px] leading-snug text-ink-48">
            두 AI의 답은 추정·의견이며 사실과 다를 수 있습니다. 투자 권유가 아니라 참고용이며, 최종 판단·책임은 본인에게 있습니다.
          </p>
        </Card>
      )}

      {/* 이력 */}
      {history.length > 0 && (
        <Card className="mt-4">
          <SectionLabel>지난 질문 · 시황 반영 관리</SectionLabel>
          <p className="mb-1 text-[12px] text-ink-48">
            ‘시황 반영’을 켜둔 질문의 답은 장중 시황 해설·컨설팅을 만들 때 참고 자료로 들어갑니다.
          </p>
          <div>
            {history.map((row) => (
              <HistoryItem key={row.id} row={row} onToggle={onToggle} onDelete={onDelete} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
