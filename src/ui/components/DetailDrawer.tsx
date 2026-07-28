import * as Dialog from '@radix-ui/react-dialog';
import { isEditableTarget } from '../lib';
import { useUiStore } from '../store';
import { NoteDetail } from './NoteDetail';
import { CommentComposer, Timeline } from './Timeline';
import { TodoDetail } from './TodoDetail';

/**
 * 우측 상세 드로어 — todo/note 상세 + 상태 버튼 + 히스토리 타임라인.
 *
 * 셸은 Radix Dialog 다. 손으로 구현하던 세 가지(Escape 닫기, backdrop 클릭 닫기,
 * body 스크롤 잠금)를 Radix 가 맡고, 없던 포커스 트랩과 aria 배선을 얻는다.
 * 시각은 기존 그대로 — Overlay 가 스크림, Content 가 우측 패널이다(예전에는
 * backdrop 이 flex 컨테이너로 패널을 오른쪽에 놓았지만, Radix 는 둘이 형제라
 * Content 를 fixed right 로 직접 붙인다 — 렌더 결과는 같다).
 */
export function DetailDrawer() {
  const detail = useUiStore((s) => s.detail);
  const closeDetail = useUiStore((s) => s.closeDetail);

  return (
    <Dialog.Root
      open={detail !== null}
      onOpenChange={(open) => {
        if (!open) {
          closeDetail();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="drawer-backdrop fixed inset-0 z-10 bg-(--scrim)" />
        <Dialog.Content
          className="drawer fixed inset-y-0 right-0 z-10 h-full w-[min(440px,92vw)] overflow-y-auto overscroll-contain border-l border-(--line) bg-(--surface) px-[22px] py-5 max-[900px]:w-screen"
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => {
            // 입력 중인 Esc 는 그 입력의 취소지 드로어 닫기가 아니다 — 제목 편집뿐 아니라
            // 설명 textarea 에서도 편집분이 날아가지 않게 여기서 걸러 낸다.
            if (isEditableTarget(e.target)) {
              e.preventDefault();
            }
          }}
        >
          {/* 제목은 상세 컴포넌트 안의 h2(.drawer-title)가 시각적으로 맡는다 — Radix 의
              접근성 요구(Title 필수)는 스크린리더 전용 제목으로 충족한다. */}
          <Dialog.Title className="sr-only">
            {detail?.kind === 'todo' ? 'todo 상세' : '메모 상세'}
          </Dialog.Title>
          <Dialog.Close asChild>
            <button
              type="button"
              className="drawer-close absolute top-3.5 right-4 text-sm text-(--faint) hover:text-(--text) max-[900px]:min-h-11 max-[900px]:min-w-11"
            >
              ✕
            </button>
          </Dialog.Close>
          {detail &&
            (detail.kind === 'todo' ? (
              <>
                <TodoDetail />
                {detail.todo && <CommentComposer todoId={detail.todo.id} />}
              </>
            ) : (
              <NoteDetail />
            ))}
          {detail && <Timeline history={detail.history} comments={detail.comments} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
