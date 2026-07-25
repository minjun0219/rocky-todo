import { useEffect, useState } from 'react';
import type { HistoryEntry } from '../../store';
import {
  actorTone,
  copyRefWithFeedback,
  formatElapsed,
  isEditableTarget,
  linkLabel,
  mdTokens,
} from '../lib';
import { useUiStore } from '../store';

/** 우측 상세 드로어 — todo/note 상세 + 상태 버튼 + 히스토리 타임라인. */
export function DetailDrawer() {
  const detail = useUiStore((s) => s.detail);
  const closeDetail = useUiStore((s) => s.closeDetail);

  // Escape 로 닫기 — backdrop 클릭과 함께 키보드 접근성 확보
  useEffect(() => {
    if (!detail) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      // 입력 중인 Esc 는 그 입력의 취소지 드로어 닫기가 아니다 — 제목 편집뿐 아니라
      // 설명 textarea 에서도 편집분이 날아가지 않게 전역에서 걸러 낸다.
      if (e.key === 'Escape' && !isEditableTarget(e.target)) {
        closeDetail();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detail, closeDetail]);

  if (!detail) {
    return null;
  }

  return (
    <div className="drawer-backdrop">
      <button type="button" className="backdrop-hit" aria-label="상세 닫기" onClick={closeDetail} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <button type="button" className="drawer-close" onClick={closeDetail}>
          ✕
        </button>
        {detail.kind === 'todo' ? <TodoDetail /> : <NoteDetail />}
        <HistoryTimeline history={detail.history} />
      </aside>
    </div>
  );
}

function TodoDetail() {
  const detail = useUiStore((s) => s.detail);
  const setTodoStatus = useUiStore((s) => s.setTodoStatus);
  const patchTodo = useUiStore((s) => s.patchTodo);
  const sections = useUiStore((s) => s.sections);
  const todo = detail?.todo;
  const [desc, setDesc] = useState(todo?.description ?? '');
  const [editingDesc, setEditingDesc] = useState(false);
  const [copied, setCopied] = useState(false);
  const [title, setTitle] = useState(todo?.title ?? '');
  const [editingTitle, setEditingTitle] = useState(false);

  useEffect(() => {
    if (!editingDesc) {
      setDesc(todo?.description ?? '');
    }
  }, [todo?.description, editingDesc]);

  useEffect(() => {
    if (!editingTitle) {
      setTitle(todo?.title ?? '');
    }
  }, [todo?.title, editingTitle]);

  if (!todo) {
    return null;
  }

  const handleCopyRef = () => copyRefWithFeedback(todo.ref, setCopied);

  /** 제목은 필수 필드다 — 빈 값이면 저장하지 않고 편집 모드만 닫는다. */
  const commitTitle = () => {
    const next = title.trim();
    setEditingTitle(false);
    if (next === '' || next === todo.title) {
      setTitle(todo.title);
      return;
    }
    void patchTodo(todo.id, { title: next });
  };

  const statusButton = (label: string, action: Parameters<typeof setTodoStatus>[1]) => (
    <button
      type="button"
      className="drawer-btn"
      onClick={() => void setTodoStatus(todo.id, action)}
    >
      {label}
    </button>
  );

  return (
    <div className="drawer-body">
      <button
        type="button"
        className="drawer-ref"
        onClick={() => void handleCopyRef()}
        title={copied ? '복사됨' : `${todo.ref} 복사`}
        aria-label={copied ? '복사됨' : `${todo.ref} 복사`}
      >
        {copied ? '✓' : todo.ref}
      </button>
      {editingTitle ? (
        <input
          className="drawer-title-input"
          value={title}
          // biome-ignore lint/a11y/noAutofocus: 클릭으로 진입한 편집이라 즉시 입력이 기대 동작
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              // 커밋은 onBlur 한 곳에서만 — 여기서 직접 부르면 뒤따르는 blur 와 겹쳐
              // 같은 변경이 두 번 PATCH 되고 히스토리에도 두 줄 남는다.
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              // 드로어의 window keydown 리스너까지 올라가면 편집 취소가 아니라 드로어가
              // 통째로 닫힌다 — 안내한 "Esc 취소"와 다른 동작이 되므로 여기서 끊는다.
              e.stopPropagation();
              setTitle(todo.title);
              setEditingTitle(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="drawer-title"
          onClick={() => setEditingTitle(true)}
          title="클릭해서 제목 수정 (Enter 저장 · Esc 취소)"
        >
          {todo.title}
        </button>
      )}
      <div className="drawer-id">{todo.id}</div>
      <div className="drawer-chips">
        <span className={`chip prio-${todo.priority}`}>{todo.priority}</span>
        {todo.labels.map((label) => (
          <span key={label} className="chip chip-label">
            {label}
          </span>
        ))}
        {todo.due && <span className="chip chip-due">{todo.due}</span>}
        {todo.archivedAt && <span className="chip">보관됨</span>}
      </div>
      {/* 섹션 이동 — 이 보드의 섹션만 후보다. 빈 값은 섹션 해제(store 가 공백을 해제로 읽는다). */}
      <label className="drawer-section-pick">
        <span className="drawer-section-label">섹션</span>
        <select
          className="drawer-select"
          value={todo.sectionId ?? ''}
          onChange={(e) => {
            const picked = sections.find((s) => s.id === e.target.value);
            void patchTodo(todo.id, { section: picked ? picked.title : null });
          }}
        >
          <option value="">(없음)</option>
          {sections
            .filter((s) => s.boardId === todo.boardId)
            .map((section) => (
              <option key={section.id} value={section.id}>
                {section.title}
              </option>
            ))}
        </select>
      </label>
      {todo.links.length > 0 && (
        <div className="drawer-links">
          {todo.links.map((link) => (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="chip chip-link"
            >
              {link.title ?? linkLabel(link.url)} ↗
            </a>
          ))}
        </div>
      )}
      <div className="drawer-section-label">설명</div>
      {editingDesc ? (
        <div>
          <textarea
            className="drawer-desc-edit"
            value={desc}
            rows={8}
            onChange={(e) => setDesc(e.target.value)}
          />
          <div className="drawer-actions">
            <button
              type="button"
              className="drawer-btn"
              onClick={() => {
                void patchTodo(todo.id, { description: desc });
                setEditingDesc(false);
              }}
            >
              저장
            </button>
            <button type="button" className="drawer-btn" onClick={() => setEditingDesc(false)}>
              취소
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="drawer-desc" onClick={() => setEditingDesc(true)}>
          {todo.description === '' ? (
            <span className="drawer-desc-empty">설명 없음 — 눌러서 작성</span>
          ) : (
            <Markdown text={todo.description} />
          )}
        </button>
      )}
      <div className="drawer-actions">
        {todo.status !== 'doing' && statusButton('▶ 시작', 'start')}
        {todo.status === 'doing' && statusButton('⏸ 중단', 'stop')}
        {todo.status !== 'done' && statusButton('✓ 완료', 'done')}
        {todo.status === 'done' && statusButton('↺ 다시 열기', 'reopen')}
        {todo.archivedAt
          ? statusButton('보관 해제', 'unarchive')
          : statusButton('▣ 보관', 'archive')}
      </div>
    </div>
  );
}

function NoteDetail() {
  const detail = useUiStore((s) => s.detail);
  const note = detail?.note;
  const [copied, setCopied] = useState(false);

  if (!note) {
    return null;
  }

  // 글로벌 메모는 note.ref 가 `#3` 처럼 보드 접두사 없이 오는데, copyRefWithFeedback 은
  // 그 문자열을 그대로 복사하므로 별도 분기가 없다.
  const handleCopyRef = () => copyRefWithFeedback(note.ref, setCopied);

  return (
    <div className="drawer-body">
      <button
        type="button"
        className="drawer-ref"
        onClick={() => void handleCopyRef()}
        title={copied ? '복사됨' : `${note.ref} 복사`}
        aria-label={copied ? '복사됨' : `${note.ref} 복사`}
      >
        {copied ? '✓' : note.ref}
      </button>
      <h2 className="drawer-title">{note.title}</h2>
      <div className="drawer-id">{note.id}</div>
      <div className="drawer-desc drawer-desc-static">
        <Markdown text={note.content} />
      </div>
    </div>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, lineIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 정적 텍스트 줄 렌더
        <p key={lineIndex} className="md-line">
          {mdTokens(line).map((token, i) => {
            const key = `${i}-${token.value}`;
            if (token.type === 'bold') {
              return <strong key={key}>{token.value}</strong>;
            }
            if (token.type === 'code') {
              return <code key={key}>{token.value}</code>;
            }
            if (token.type === 'link') {
              return (
                <a key={key} href={token.value} target="_blank" rel="noreferrer">
                  {token.value}
                </a>
              );
            }
            return <span key={key}>{token.value}</span>;
          })}
        </p>
      ))}
    </>
  );
}

function HistoryTimeline({ history }: { history: HistoryEntry[] }) {
  return (
    <div className="drawer-history">
      <div className="drawer-section-label">히스토리</div>
      {history.map((entry) => (
        <div key={entry.id} className="history-row">
          <span className={`history-dot tone-${actorTone(entry.actor)}`} />
          <span className={`history-actor tone-${actorTone(entry.actor)}`}>{entry.actor}</span>
          <span className="history-action">{actionLabel(entry.action)}</span>
          {entry.changes?.title && (
            <span className="history-change">→ {String(entry.changes.title[1])}</span>
          )}
          <span className="history-at">{formatElapsed(entry.at)} 전</span>
        </div>
      ))}
    </div>
  );
}

const ACTION_LABELS: Record<string, string> = {
  create: '생성',
  update: '수정',
  start: '시작',
  stop: '중단',
  done: '완료',
  reopen: '다시 열기',
  archive: '보관',
  unarchive: '보관 해제',
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}
