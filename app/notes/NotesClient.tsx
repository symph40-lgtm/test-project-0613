"use client";

import { useState, useTransition } from "react";
import { Pin, PinOff, Pencil, Trash2, Check, X, Plus } from "lucide-react";
import { Button } from "../_components/Button";
import { Card, SectionLabel, StateNote } from "../_components/primitives";
import { addNote, updateNote, togglePin, deleteNote, type NoteRow } from "./actions";

function fmt(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const PLACEHOLDER =
  "예: 7월은 이익이 3.5억 넘어 보수적 유지 · 현금 40% 확보. 연기금 매도로 주가가 주기적으로 하락 예상 → 하락 시 매수, 상승 시 즉시 매도.";

export default function NotesClient({ initialNotes }: { initialNotes: NoteRow[] }) {
  const [notes, setNotes] = useState<NoteRow[]>(initialNotes);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function resort(list: NoteRow[]): NoteRow[] {
    return [...list].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.updated_at < b.updated_at ? 1 : -1;
    });
  }

  function handleAdd() {
    const b = draft.trim();
    if (!b) return;
    setError(null);
    startTransition(async () => {
      const r = await addNote(b);
      if (r.error) return setError(r.error);
      if (r.note) {
        setNotes((ns) => resort([r.note!, ...ns]));
        setDraft("");
      }
    });
  }

  function startEdit(n: NoteRow) {
    setEditingId(n.id);
    setEditBody(n.body);
  }

  function saveEdit() {
    if (!editingId) return;
    const b = editBody.trim();
    if (!b) return;
    setError(null);
    startTransition(async () => {
      const r = await updateNote(editingId, b);
      if (r.error) return setError(r.error);
      const now = new Date().toISOString();
      setNotes((ns) => resort(ns.map((n) => (n.id === editingId ? { ...n, body: b, updated_at: now } : n))));
      setEditingId(null);
    });
  }

  function handlePin(n: NoteRow) {
    const next = !n.pinned;
    setNotes((ns) => resort(ns.map((x) => (x.id === n.id ? { ...x, pinned: next } : x))));
    startTransition(async () => {
      await togglePin(n.id, next);
    });
  }

  function handleDelete(id: string) {
    if (!confirm("이 메모를 삭제하시겠습니까?")) return;
    setNotes((ns) => ns.filter((n) => n.id !== id));
    startTransition(async () => {
      await deleteNote(id);
    });
  }

  return (
    <div className="mt-6">
      {/* 작성 */}
      <Card>
        <SectionLabel>새 메모</SectionLabel>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleAdd();
          }}
          placeholder={PLACEHOLDER}
          rows={4}
          className="w-full resize-y rounded-[10px] border border-hairline bg-canvas px-3.5 py-3 text-[15px] leading-relaxed outline-none placeholder:text-ink-48 focus:border-guard"
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[12px] text-ink-48">⌘/Ctrl + Enter 로 저장</span>
          <Button variant="primary" onClick={handleAdd} disabled={isPending || !draft.trim()} className="!px-5 !py-2.5 !text-[15px] shrink-0">
            <Plus size={15} /> 메모 추가
          </Button>
        </div>
        {error && <p className="mt-2 text-[13px] text-red-500">{error}</p>}
      </Card>

      {/* 목록 */}
      {notes.length === 0 ? (
        <div className="mt-4">
          <StateNote title="아직 메모가 없습니다.">위에 첫 메모를 적어보세요. 투자 원칙·주의할 점·시장 메모를 자유롭게 남길 수 있습니다.</StateNote>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {notes.map((n) => (
            <Card key={n.id} className={n.pinned ? "border-guard/40" : ""}>
              {editingId === n.id ? (
                <>
                  <textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    rows={4}
                    className="w-full resize-y rounded-[10px] border border-hairline bg-canvas px-3 py-2.5 text-[15px] leading-relaxed outline-none focus:border-guard"
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <Button variant="primary" onClick={saveEdit} disabled={isPending} className="!px-4 !py-2 !text-[14px]">
                      <Check size={14} /> 저장
                    </Button>
                    <Button variant="secondary" onClick={() => setEditingId(null)} className="!px-4 !py-2 !text-[14px]">
                      <X size={14} /> 취소
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink-80">{n.body}</p>
                    <div className="flex shrink-0 gap-1">
                      <button onClick={() => handlePin(n)} title={n.pinned ? "고정 해제" : "고정"} className="grid size-7 place-items-center rounded-full text-ink-48 hover:bg-divider">
                        {n.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                      </button>
                      <button onClick={() => startEdit(n)} className="grid size-7 place-items-center rounded-full text-ink-48 hover:bg-divider">
                        <Pencil size={14} />
                      </button>
                      <button onClick={() => handleDelete(n.id)} className="grid size-7 place-items-center rounded-full text-ink-48 hover:bg-divider">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  <p className="mt-2 text-[12px] text-ink-48">
                    {n.pinned ? "📌 고정 · " : ""}
                    {fmt(n.updated_at)}
                  </p>
                </>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
