import { useEffect } from 'react';
import { isEditableTarget } from '../lib';
import { useUiStore } from '../store';
import { NoteDetail } from './drawer/NoteDetail';
import { CommentComposer, Timeline } from './drawer/Timeline';
import { TodoDetail } from './drawer/TodoDetail';

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

  // 드로어가 열린 동안 배경 스크롤을 잠근다. 정리 함수에서 **반드시** 지운다 —
  // 남기면 드로어를 닫은 뒤 페이지 전체가 스크롤 불가가 된다.
  useEffect(() => {
    if (!detail) {
      return;
    }
    document.body.classList.add('is-drawer-open');
    return () => document.body.classList.remove('is-drawer-open');
  }, [detail]);

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
        {detail.kind === 'todo' && detail.todo && <CommentComposer todoId={detail.todo.id} />}
        <Timeline history={detail.history} comments={detail.comments} />
      </aside>
    </div>
  );
}
