import { useState } from 'react';
import { copyRefWithFeedback } from '../lib';
import { useUiStore } from '../store';
import { Markdown } from './Markdown';

export function NoteDetail() {
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
        className="drawer-ref cursor-pointer text-[0.9em] text-(--muted) tabular-nums hover:text-(--text) hover:underline max-[900px]:inline-flex max-[900px]:min-h-11 max-[900px]:min-w-11 max-[900px]:items-center"
        onClick={() => void handleCopyRef()}
        title={copied ? '복사됨' : `${note.ref} 복사`}
        aria-label={copied ? '복사됨' : `${note.ref} 복사`}
      >
        {copied ? '✓' : note.ref}
      </button>
      <h2 className="drawer-title mt-1 mb-2.5 text-lg leading-[1.35] font-bold text-(--text)">
        {note.title}
      </h2>
      <div className="drawer-id mt-0.5 mb-2.5 font-(family-name:--mono) text-[10px] tracking-[0.14em] text-(--faint)">
        {note.id}
      </div>
      <div className="drawer-desc drawer-desc-static block w-full cursor-default rounded-lg border border-(--line-strong) bg-(--bg) px-3 py-2.5 text-left text-[13px] text-(--text)">
        <Markdown text={note.content} />
      </div>
    </div>
  );
}
