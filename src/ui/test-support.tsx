import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import type { Board } from '../store';
import type { TodoView } from '../server';
import { useUiStore } from './store';

/**
 * 웹 UI 렌더 테스트의 공용 픽스처/헬퍼.
 *
 * 렌더 테스트는 `bun test --preload ./src/ui/happydom.ts` 로만 돈다 (`*.test.tsx`).
 * 이 모듈을 순수 실행(`*.test.ts`)에서 import 하면 DOM 전역이 없어 터진다.
 */

/** 기본값이 채워진 TodoView — 검증에 쓰는 필드만 덮어쓴다. */
export function todoFixture(over: Partial<TodoView> = {}): TodoView {
  return {
    id: 'todo1',
    number: 1,
    boardId: 'board1',
    title: '원래 제목',
    description: '',
    status: 'todo',
    priority: 'p4',
    labels: [],
    links: [],
    position: 0,
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    ref: 'rocky-todo-1',
    commentCount: 0,
    ...over,
  };
}

/** 기본값이 채워진 Board. */
export function boardFixture(over: Partial<Board> = {}): Board {
  return {
    id: 'board1',
    key: 'rocky-todo',
    title: 'rocky-todo',
    createdAt: '2026-07-27T00:00:00.000Z',
    ...over,
  };
}

// 아직 아무 테스트도 건드리지 않은 시점의 스토어 — `renderWithStore` 가 매번 여기로
// 되돌린 뒤 그 테스트가 쓰는 필드만 얹는다. import 시점에 한 번만 읽는다.
const pristineState = useUiStore.getState();

/**
 * 스토어를 기준 상태로 되돌리고 주어진 필드만 덮어쓴 뒤 컴포넌트를 렌더한다.
 *
 * zustand 스토어는 모듈 싱글턴이라 파일 안의 테스트들이 같은 인스턴스를 공유한다 —
 * 부분 병합만 하면 앞 테스트가 넣은 `actor`/`sessions` 같은 필드가 다음 테스트로 새어
 * 들어간다. 그래서 `replace: true` 로 매번 초기 상태를 깔고 시작한다. 그래도 각 테스트는
 * 자기가 읽는 필드를 명시하는 편이 좋다 — 무엇에 기대는지가 테스트에 남는다.
 * 액션 자리에는 `mock()` 을 넣어 호출을 관찰한다.
 */
export function renderWithStore(
  ui: ReactElement,
  state: Partial<ReturnType<typeof useUiStore.getState>>,
) {
  useUiStore.setState({ ...pristineState, ...state }, true);
  return render(ui);
}
