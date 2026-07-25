import { useEffect, useState } from 'react';
import type { NoteView } from '../../server';
import { copyRef, formatElapsed } from '../lib';
import { useUiStore } from '../store';

/** 우측 메모 레일 — 스티커 카드. 인라인 편집, 저장/보관은 서버 확정 후 반영. */
export function NotesRail() {
  const notes = useUiStore((s) => s.notes);
  const selected = useUiStore((s) => s.selected);
  const addNote = useUiStore((s) => s.addNote);

  return (
    <aside className="notes-rail">
      <div className="notes-head">
        <span className="sidebar-label">NOTES</span>
        <button
          type="button"
          className="notes-add"
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
      {notes.length === 0 && <div className="empty-state">메모가 없다. 스크래치패드로 쓰자.</div>}
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

  // TodoItem 의 todo-ref 버튼과 동일한 복사 흐름. 글로벌 메모는 note.ref 가 `#3` 처럼
  // 보드 접두사 없이 오는데, copyRef 는 그 문자열을 그대로 복사하므로 별도 분기가 없다.
  const handleCopyRef = async () => {
    const ok = await copyRef(note.ref);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
      return;
    }
    window.prompt('클립보드에 접근할 수 없다 — 아래 텍스트를 직접 복사해라:', note.ref);
  };

  return (
    <div className={`note-card ${note.archivedAt ? 'is-archived' : ''}`}>
      <div className="note-card-head">
        <button
          type="button"
          className="todo-ref"
          onClick={() => void handleCopyRef()}
          title={copied ? '복사됨' : `${note.ref} 복사`}
          aria-label={copied ? '복사됨' : `${note.ref} 복사`}
        >
          {copied ? '✓' : `#${note.number}`}
        </button>
        <input
          className="note-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={save}
        />
        <button
          type="button"
          className="note-action"
          title="히스토리"
          onClick={() => void openNoteDetail(note.id)}
        >
          ⌚
        </button>
        <button
          type="button"
          className="note-action"
          title="보관 (삭제는 없다)"
          onClick={() => void archiveNote(note.id)}
        >
          ▣
        </button>
      </div>
      <textarea
        className="note-content"
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
      <div className="note-meta">
        {dirty ? '수정중… (blur 로 저장)' : `갱신 ${formatElapsed(note.updatedAt)} 전`}
      </div>
    </div>
  );
}
