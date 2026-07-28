import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TodoView } from '../../server';
import { useUiStore } from '../store';
import { renderWithStore, todoFixture } from '../test-support';
import { TodoItem } from './TodoItem';

afterEach(cleanup);

/** todo 한 줄을 띄우고 setTodoStatus 스파이를 돌려준다. */
function mountItem(todo: TodoView, seenComments: Record<string, string> = {}) {
  const setTodoStatus = mock(async () => {});
  renderWithStore(<TodoItem todo={todo} depth={0} />, {
    setTodoStatus,
    openTodoDetail: mock(async () => {}),
    seenComments,
    handoffs: [],
  });
  return { setTodoStatus };
}

describe('TodoItem 체크박스', () => {
  test('열린 항목을 체크하면 done 으로 보낸다', async () => {
    const { setTodoStatus } = mountItem(todoFixture());
    await userEvent.click(screen.getByRole('checkbox', { name: '완료' }));
    expect(setTodoStatus.mock.calls[0]).toEqual(['todo1', 'done'] as never);
  });

  test('완료된 항목을 체크 해제하면 reopen 으로 보낸다', async () => {
    const { setTodoStatus } = mountItem(todoFixture({ status: 'done' }));
    await userEvent.click(screen.getByRole('checkbox', { name: '다시 열기' }));
    expect(setTodoStatus.mock.calls[0]).toEqual(['todo1', 'reopen'] as never);
  });
});

describe('TodoItem 댓글 배지', () => {
  const commented = todoFixture({ commentCount: 2, lastCommentAt: '2026-07-27T05:00:00.000Z' });

  test('커서보다 새 댓글이 있으면 미읽음으로 표시한다', () => {
    mountItem(commented, { todo1: '2026-07-27T04:00:00.000Z' });
    expect(screen.getByRole('button', { name: /읽지 않은 댓글 2개/ })).toBeDefined();
  });

  // 커서를 localStorage 에서 직접 읽으면 값이 바뀌어도 리렌더가 걸리지 않아 배지가
  // 다음 refetch 까지 강조된 채 남는다 — 그래서 zustand 상태에서 읽는다.
  test('커서가 갱신되면 강조가 즉시 풀린다', () => {
    mountItem(commented, { todo1: '2026-07-27T04:00:00.000Z' });
    act(() => useUiStore.setState({ seenComments: { todo1: '2026-07-27T06:00:00.000Z' } }));
    expect(screen.getByRole('button', { name: /^댓글 2개/ })).toBeDefined();
  });
});

describe('TodoItem doing 배지', () => {
  test('처리중이면 누가 잡고 있는지 보여준다', () => {
    mountItem(
      todoFixture({
        status: 'doing',
        doingBy: 'claude-code',
        doingSince: new Date().toISOString(),
      }),
    );
    expect(screen.getByTitle('처리중').textContent).toContain('claude-code');
  });
});

describe('TodoItem 참조 복사 버튼', () => {
  test('클립보드에는 슬래시 커맨드가 들어가고 버튼에는 번호만 보인다', async () => {
    const written: string[] = [];
    // navigator.clipboard 는 원래 속성 서술자를 저장해두고 try/finally 로 되돌린다 —
    // test:dom 은 src 전체를 한 프로세스에서 돌리므로, expect 가 먼저 throw 해도
    // 이 스텁이 뒤에 실행되는 다른 *.test.tsx 로 새어나가면 안 된다.
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t: string) => void written.push(t) },
    });

    try {
      mountItem(todoFixture({ number: 12, ref: 'rocky-12' }));

      const button = screen.getByRole('button', { name: 'rocky-12 복사' });
      expect(button.textContent).toBe('12');

      await userEvent.click(button);
      expect(written).toEqual(['/rocky-todo:board rocky-12']);
    } finally {
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      } else {
        delete (navigator as { clipboard?: unknown }).clipboard;
      }
    }
  });
});
