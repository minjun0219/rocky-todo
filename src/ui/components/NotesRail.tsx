import { useEffect, useState, useSyncExternalStore } from 'react';
import type { NoteView } from '../../server';
import { boardCommand, copyRefWithFeedback, formatElapsed } from '../lib';
import { useUiStore } from '../store';

const NARROW_QUERY = '(max-width: 900px)';

/** 좁은 화면인가 — responsive.css 의 900px 경계와 같은 값이다. */
function useIsNarrow(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const mq = window.matchMedia(NARROW_QUERY);
      mq.addEventListener('change', notify);
      return () => mq.removeEventListener('change', notify);
    },
    () => window.matchMedia(NARROW_QUERY).matches,
  );
}

/**
 * 우측 메모 레일 — 스티커 카드. 인라인 편집, 저장/보관은 서버 확정 후 반영.
 *
 * 좁은 화면에선 세로 스택의 맨 아래라 도달이 멀어 **기본 접힘**이다 — 헤더가 토글이
 * 되고 개수만 보인다(보드 항목: 모바일 메모 레일 접근성). 넓은 화면에선 토글이
 * 비활성이고 본문은 항상 보인다(`responsive.css`).
 */
export function NotesRail() {
  const notes = useUiStore((s) => s.notes);
  const selected = useUiStore((s) => s.selected);
  const addNote = useUiStore((s) => s.addNote);
  const [mobileOpen, setMobileOpen] = useState(false);
  // 넓은 화면에선 본문이 항상 보이므로 토글은 no-op 이고 aria 도 '펼침'이 정직하다.
  const isNarrow = useIsNarrow();

  return (
    <aside className={`notes-rail ${mobileOpen ? 'is-open' : ''}`}>
      <div className="notes-head">
        <button
          type="button"
          className="notes-toggle"
          aria-expanded={isNarrow ? mobileOpen : true}
          onClick={() => {
            if (isNarrow) {
              setMobileOpen((v) => !v);
            }
          }}
        >
          <span className="sidebar-label">
            NOTES
            {notes.length > 0 ? ` · ${notes.length}` : ''}
            <span className="notes-caret">{mobileOpen ? ' ▾' : ' ▸'}</span>
          </span>
        </button>
        <button
          type="button"
          className="notes-add"
          onClick={() => {
            setMobileOpen(true); // 접힌 채 추가하면 새 메모가 안 보인다
            void addNote({
              board: selected === 'all' ? undefined : selected,
              title: '새 메모',
            });
          }}
        >
          + 메모
        </button>
      </div>
      <div className="notes-body">
        {notes.length === 0 && <div className="empty-state">메모가 없다. 스크래치패드로 쓰자.</div>}
        {notes.map((note) => (
          <NoteCard key={note.id} note={note} />
        ))}
      </div>
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

  // 글로벌 메모는 note.ref 가 `note-3` 으로 오고 보드 메모는 `rocky-3` 으로 온다 —
  // 어느 쪽이든 boardCommand 가 그대로 감싸므로 별도 분기가 없다.
  const handleCopyRef = () => copyRefWithFeedback(boardCommand(note.ref), setCopied);

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
          {copied ? '✓' : note.number}
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
