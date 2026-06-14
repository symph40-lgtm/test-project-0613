"use client";

import { useState, useTransition } from "react";
import { Plus, Pencil, Trash2, Check, X } from "lucide-react";
import { ButtonLink } from "../_components/Button";
import { RiskBadge, StateNote } from "../_components/primitives";
import {
  addPosition,
  updatePosition,
  deletePosition,
  type PositionRow,
} from "./actions";

type EditState = {
  id: string;
  pnl: string;
  sector: string;
  weight: string;
  is_leverage: boolean;
} | null;

type AddState = {
  ticker: string;
  weight: string;
  is_leverage: boolean;
};

export default function PositionsClient({
  initialPositions,
}: {
  initialPositions: PositionRow[];
}) {
  const [positions, setPositions] = useState(initialPositions);
  const [editing, setEditing] = useState<EditState>(null);
  const [adding, setAdding] = useState(false);
  const [addState, setAddState] = useState<AddState>({
    ticker: "",
    weight: "",
    is_leverage: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function startEdit(p: PositionRow) {
    setEditing({
      id: p.id,
      pnl: p.pnl !== null ? String(p.pnl) : "",
      sector: p.sector ?? "",
      weight: String(p.weight),
      is_leverage: p.is_leverage,
    });
  }

  function handleSaveEdit() {
    if (!editing) return;
    setError(null);
    startTransition(async () => {
      const result = await updatePosition(editing.id, {
        pnl: editing.pnl !== "" ? Number(editing.pnl) : null,
        weight: Number(editing.weight),
        is_leverage: editing.is_leverage,
        sector: editing.sector || null,
      });
      if (result.error) {
        setError(result.error);
      } else {
        // 로컬 상태 반영
        setPositions((ps) =>
          ps.map((p) =>
            p.id === editing.id
              ? {
                  ...p,
                  pnl: editing.pnl !== "" ? Number(editing.pnl) : null,
                  weight: Number(editing.weight),
                  is_leverage: editing.is_leverage,
                  sector: editing.sector || null,
                }
              : p,
          ),
        );
        setEditing(null);
      }
    });
  }

  function handleDelete(id: string) {
    if (!confirm("종목을 삭제하시겠습니까?")) return;
    setError(null);
    startTransition(async () => {
      const result = await deletePosition(id);
      if (result.error) {
        setError(result.error);
      } else {
        setPositions((ps) => ps.filter((p) => p.id !== id));
      }
    });
  }

  function handleAdd() {
    setError(null);
    const formData = new FormData();
    formData.set("ticker", addState.ticker);
    formData.set("weight", addState.weight);
    formData.set("is_leverage", String(addState.is_leverage));

    startTransition(async () => {
      const result = await addPosition(formData);
      if (result.error) {
        setError(result.error);
      } else {
        setAdding(false);
        setAddState({ ticker: "", weight: "", is_leverage: false });
        // 서버에서 최신 데이터 반영 위해 페이지 새로고침 (revalidatePath 트리거)
        window.location.reload();
      }
    });
  }

  const empty = positions.length === 0;

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[17px] font-semibold">내 주요 포지션</h2>
        <span className="text-[13px] text-ink-48">{positions.length} / 10 등록</span>
      </div>

      {error ? (
        <p className="mb-3 text-[13px] text-red-500">{error}</p>
      ) : null}

      {empty && !adding ? (
        <StateNote title="주요 종목을 추가해 위험 노출을 확인하세요.">
          실제 의사결정에 큰 영향을 주는 포지션을 우선 등록하면 됩니다.
        </StateNote>
      ) : (
        <>
          {/* 데스크톱: 테이블 */}
          <div className="hidden overflow-hidden rounded-[18px] border border-hairline sm:block">
            <table className="w-full text-left text-[15px]">
              <thead className="bg-pearl text-[13px] text-ink-48">
                <tr>
                  <th className="px-4 py-3 font-medium">종목</th>
                  <th className="px-4 py-3 font-medium">비중</th>
                  <th className="px-4 py-3 font-medium">손익</th>
                  <th className="px-4 py-3 font-medium">유형</th>
                  <th className="px-4 py-3 font-medium">섹터 / 위험</th>
                  <th className="px-4 py-3 font-medium w-20"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-divider">
                {positions.map((p) =>
                  editing?.id === p.id ? (
                    <tr key={p.id} className="bg-pearl/50">
                      <td className="px-4 py-2 font-semibold">{p.ticker}</td>
                      <td className="px-4 py-2">
                        <input
                          value={editing.weight}
                          onChange={(e) =>
                            setEditing((s) => s && { ...s, weight: e.target.value.replace(/[^\d.]/g, "") })
                          }
                          className="h-8 w-16 rounded border border-hairline px-2 text-[14px]"
                        />
                        <span className="ml-1 text-ink-48">%</span>
                      </td>
                      <td className="px-4 py-2">
                        <input
                          value={editing.pnl}
                          onChange={(e) =>
                            setEditing((s) => s && { ...s, pnl: e.target.value.replace(/[^\d.-]/g, "") })
                          }
                          placeholder="손익%"
                          className="h-8 w-20 rounded border border-hairline px-2 text-[14px]"
                        />
                      </td>
                      <td className="px-4 py-2">
                        <button
                          onClick={() =>
                            setEditing((s) => s && { ...s, is_leverage: !s.is_leverage })
                          }
                          className={`rounded-full border px-3 py-1 text-[12px] ${
                            editing.is_leverage
                              ? "border-guard bg-guard text-white"
                              : "border-hairline text-ink-80"
                          }`}
                        >
                          {editing.is_leverage ? "레버리지" : "일반"}
                        </button>
                      </td>
                      <td className="px-4 py-2">
                        <input
                          value={editing.sector}
                          onChange={(e) =>
                            setEditing((s) => s && { ...s, sector: e.target.value })
                          }
                          placeholder="섹터"
                          className="h-8 w-24 rounded border border-hairline px-2 text-[13px]"
                        />
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex gap-1">
                          <button
                            onClick={handleSaveEdit}
                            disabled={isPending}
                            className="grid size-7 place-items-center rounded-full bg-guard text-white"
                          >
                            <Check size={13} />
                          </button>
                          <button
                            onClick={() => setEditing(null)}
                            className="grid size-7 place-items-center rounded-full border border-hairline text-ink-48"
                          >
                            <X size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr key={p.id}>
                      <td className="px-4 py-3 font-semibold">{p.ticker}</td>
                      <td className="px-4 py-3 tabular-nums">{p.weight}%</td>
                      <td className="px-4 py-3 tabular-nums">
                        {p.pnl !== null
                          ? p.pnl > 0
                            ? `+${p.pnl}%`
                            : `${p.pnl}%`
                          : "—"}
                      </td>
                      <td className="px-4 py-3">{p.is_leverage ? "레버리지" : "일반"}</td>
                      <td className="px-4 py-3">
                        <span className="mr-2 text-ink-80">{p.sector ?? "—"}</span>
                        {p.risk_level ? <RiskBadge level={p.risk_level} /> : null}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          <button
                            onClick={() => startEdit(p)}
                            className="grid size-7 place-items-center rounded-full text-ink-48 hover:bg-divider"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            onClick={() => handleDelete(p.id)}
                            disabled={isPending}
                            className="grid size-7 place-items-center rounded-full text-ink-48 hover:bg-divider"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>

          {/* 모바일: 카드 */}
          <div className="space-y-2.5 sm:hidden">
            {positions.map((p) => (
              <div key={p.id} className="rounded-[18px] border border-hairline p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[17px] font-semibold">{p.ticker}</span>
                  {p.risk_level ? <RiskBadge level={p.risk_level} /> : null}
                </div>
                <div className="mt-1.5 flex gap-4 text-[14px] text-ink-80">
                  <span>비중 {p.weight}%</span>
                  <span>
                    손익{" "}
                    {p.pnl !== null
                      ? p.pnl > 0
                        ? `+${p.pnl}%`
                        : `${p.pnl}%`
                      : "—"}
                  </span>
                  <span>{p.is_leverage ? "레버리지" : "일반"}</span>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <p className="text-[13px] text-ink-48">{p.sector ?? "섹터 미설정"}</p>
                  <div className="flex gap-1">
                    <button
                      onClick={() => startEdit(p)}
                      className="grid size-7 place-items-center rounded-full text-ink-48 hover:bg-divider"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      onClick={() => handleDelete(p.id)}
                      disabled={isPending}
                      className="grid size-7 place-items-center rounded-full text-ink-48 hover:bg-divider"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* 종목 추가 행 */}
      {adding ? (
        <div className="mt-3 flex items-center gap-2">
          <input
            value={addState.ticker}
            onChange={(e) => setAddState((s) => ({ ...s, ticker: e.target.value }))}
            placeholder="종목명"
            autoFocus
            className="h-11 flex-1 rounded-[8px] border border-hairline px-3 text-[16px] outline-none focus:border-guard"
          />
          <div className="relative w-24">
            <input
              value={addState.weight}
              onChange={(e) =>
                setAddState((s) => ({ ...s, weight: e.target.value.replace(/\D/g, "") }))
              }
              placeholder="비중"
              inputMode="numeric"
              className="h-11 w-full rounded-[8px] border border-hairline pl-3 pr-7 text-[16px] outline-none focus:border-guard"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[14px] text-ink-48">
              %
            </span>
          </div>
          <button
            onClick={() =>
              setAddState((s) => ({ ...s, is_leverage: !s.is_leverage }))
            }
            className={`h-11 shrink-0 rounded-[8px] border px-3 text-[13px] ${
              addState.is_leverage
                ? "border-guard bg-guard text-white"
                : "border-hairline text-ink-80"
            }`}
          >
            {addState.is_leverage ? "레버리지" : "일반"}
          </button>
          <button
            onClick={handleAdd}
            disabled={isPending || !addState.ticker || !addState.weight}
            className="grid size-11 shrink-0 place-items-center rounded-full bg-guard text-white disabled:opacity-40"
          >
            <Check size={16} />
          </button>
          <button
            onClick={() => setAdding(false)}
            className="grid size-11 shrink-0 place-items-center rounded-full border border-hairline text-ink-48"
          >
            <X size={16} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => {
            if (positions.length >= 10) {
              setError("최대 10개까지만 등록할 수 있습니다.");
              return;
            }
            setAdding(true);
          }}
          disabled={isPending}
          className="mt-3 flex items-center gap-1.5 px-1 py-2 text-[15px] text-guard disabled:text-ink-48"
        >
          <Plus size={16} /> 주요 종목 추가
        </button>
      )}

      <p className="mt-2 text-[13px] text-ink-48">
        &lsquo;주요 종목 최대 10개&rsquo;는 모든 보유 종목이 아니라 의사결정에 큰 영향을
        주는 포지션 기준입니다. 같은 종목을 다시 추가하면 비중이 갱신됩니다.
      </p>
    </>
  );
}
