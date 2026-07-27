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
    ref: 'rocky-todo#1',
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

/**
 * 스토어 상태를 주입하고 컴포넌트를 렌더한다.
 *
 * zustand 스토어는 모듈 싱글턴이라 파일 안의 테스트들이 상태를 공유한다 — 각 테스트가
 * 자기가 읽는 필드를 여기서 전부 명시해야 앞 테스트의 잔여 상태에 기대지 않는다.
 * 액션 자리에는 `mock()` 을 넣어 호출을 관찰한다.
 */
export function renderWithStore(
  ui: ReactElement,
  state: Partial<ReturnType<typeof useUiStore.getState>>,
) {
  useUiStore.setState(state);
  return render(ui);
}
