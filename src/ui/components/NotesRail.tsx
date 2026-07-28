import { useEffect, useState } from 'react';
import type { NoteView } from '../../server';
import { copyRefWithFeedback, formatElapsed } from '../lib';
import { useUiStore } from '../store';

/** 우측 메모 레일 — 스티커 카드. 인라인 편집, 저장/보관은 서버 확정 후 반영. */
export function NotesRail() {
  const notes = useUiStore((s) => s.notes);
  const selected = useUiStore((s) => s.selected);
  const addNote = useUiStore((s) => s.addNote);

  return (
    <aside className="notes-rail flex flex-col gap-3 overflow-y-auto border-l border-(--line) px-3.5 py-4 max-[900px]:shrink-0 max-[900px]:overflow-y-visible max-[900px]:border-l-0 max-[900px]:border-t max-[900px]:p-3.5">
      <div className="notes-head flex items-center justify-between">
        <span className="sidebar-label px-2.5 pb-1.5 font-(family-name:--mono) text-[11px] tracking-[0.22em] text-(--faint)">
          NOTES
        </span>
        <button
          type="button"
          className="notes-add text-xs text-(--warm)"
          onClick={() =>
            void addNote({
              board: selected === 'all' ? undefined : selected,
              title: '새 메모',
            })
          }
        >
          + 메모
        </button>
      </div>
      {notes.length === 0 && (
        <div className="empty-state px-1 py-[18px] text-[13px] text-(--faint)">
          메모가 없다. 스크래치패드로 쓰자.
        </div>
      )}
      {notes.map((note) => (
        <NoteCard key={note.id} note={note} />
      ))}
    </aside>
  );
}

function NoteCard({ note }: { note: NoteView }) {
  const saveNote = useUiStore((s) => s.saveNote);
  const archiveNote = useUiStore((s) => s.archiveNote);
  const openNoteDetail = useUiStore((s) => s.openNoteDetail);
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [copied, setCopied] = useState(false);

  // 다른 경로(에이전트)의 편집이 SSE refetch 로 들어오면, 내가 수정중이 아닐 때만 동기화
  useEffect(() => {
    setTitle(note.title);
    setContent(note.content);
  }, [note.title, note.content]);

  const dirty = title !== note.title || content !== note.content;

  const save = () => {
    if (!dirty) {
      return;
    }
    void saveNote(note.id, { title, content });
  };

  // 글로벌 메모는 note.ref 가 `#3` 처럼 보드 접두사 없이 오는데, copyRefWithFeedback 은
  // 그 문자열을 그대로 복사하므로 별도 분기가 없다.
  const handleCopyRef = () => copyRefWithFeedback(note.ref, setCopied);

  return (
    <div
      className={`note-card rounded-[10px] border border-(--line-strong) bg-(--surface) px-3 py-2.5 ${note.archivedAt ? 'is-archived opacity-(--dim-archived)' : ''}`}
    >
      <div className="note-card-head flex items-center gap-1">
        <button
          type="button"
          className="todo-ref min-w-[2.2em] shrink-0 cursor-pointer text-right text-[0.85em] text-(--muted) tabular-nums hover:text-(--text) hover:underline max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:min-w-11 max-[900px]:items-center"
          onClick={() => void handleCopyRef()}
          title={copied ? '복사됨' : `${note.ref} 복사`}
          aria-label={copied ? '복사됨' : `${note.ref} 복사`}
        >
          {copied ? '✓' : `#${note.number}`}
        </button>
        <input
          className="note-title min-w-0 flex-1 px-0 py-0.5 text-[13px] font-semibold max-[900px]:text-base"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={save}
        />
        <button
          type="button"
          className="note-action px-1 py-0.5 text-xs text-(--faint) hover:text-(--text) max-[900px]:min-h-11 max-[900px]:min-w-11"
          title="히스토리"
          onClick={() => void openNoteDetail(note.id)}
        >
          ⌚
        </button>
        <button
          type="button"
          className="note-action px-1 py-0.5 text-xs text-(--faint) hover:text-(--text) max-[900px]:min-h-11 max-[900px]:min-w-11"
          title="보관 (삭제는 없다)"
          onClick={() => void archiveNote(note.id)}
        >
          ▣
        </button>
      </div>
      <textarea
        className="note-content mt-1 w-full resize-y text-[13px] leading-[1.55] text-(--muted) focus:text-(--text) focus:outline-none max-[900px]:text-base"
        value={content}
        rows={Math.min(12, Math.max(3, content.split('\n').length + 1))}
        onChange={(e) => setContent(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            save();
          }
        }}
      />
      <div className="note-meta mt-1 font-(family-name:--mono) text-[11px] text-(--faint)">
        {dirty ? '수정중… (blur 로 저장)' : `갱신 ${formatElapsed(note.updatedAt)} 전`}
      </div>
    </div>
  );
}
