import { useEffect, useState } from 'react';
import type { HistoryEntry } from '../../store';
import { actorTone, formatElapsed, linkLabel, mdTokens } from '../lib';
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
      if (e.key === 'Escape') {
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
  const todo = detail?.todo;
  const [desc, setDesc] = useState(todo?.description ?? '');
  const [editingDesc, setEditingDesc] = useState(false);

  useEffect(() => {
    if (!editingDesc) {
      setDesc(todo?.description ?? '');
    }
  }, [todo?.description, editingDesc]);

  if (!todo) {
    return null;
  }

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
      <div className="drawer-id">{todo.id}</div>
      <h2 className="drawer-title">{todo.title}</h2>
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
  if (!note) {
    return null;
  }
  return (
    <div className="drawer-body">
      <div className="drawer-id">{note.id}</div>
      <h2 className="drawer-title">{note.title}</h2>
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
