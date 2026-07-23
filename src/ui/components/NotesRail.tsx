import { useEffect, useState } from 'react';
import type { Note } from '../../store';
import { formatElapsed } from '../lib';
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

function NoteCard({ note }: { note: Note }) {
  const saveNote = useUiStore((s) => s.saveNote);
  const archiveNote = useUiStore((s) => s.archiveNote);
  const openNoteDetail = useUiStore((s) => s.openNoteDetail);
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);

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

  return (
    <div className={`note-card ${note.archivedAt ? 'is-archived' : ''}`}>
      <div className="note-card-head">
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
