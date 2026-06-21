import { PageShell, Disclaimer } from "../_components/Shell";
import { getNotes } from "./actions";
import NotesClient from "./NotesClient";

export const dynamic = "force-dynamic";

export default async function NotesPage() {
  const notes = await getNotes();
  return (
    <PageShell title="투자 메모" width="default">
      <p className="text-[15px] leading-relaxed text-ink-80">
        행동·투자 방향·주의할 점·깨달은 점을 자유롭게 기록하세요. 중요한 메모는 고정해 위에 둘 수 있습니다.
      </p>
      <NotesClient initialNotes={notes} />
      <Disclaimer />
    </PageShell>
  );
}
