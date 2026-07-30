import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HandoffView } from '../../doing';
import { renderWithStore, todoFixture } from '../test-support';
import { DetailDrawer } from './DetailDrawer';

afterEach(cleanup);

/** 제목 편집 상태로 드로어를 띄우고 patchTodo 스파이를 돌려준다. */
function mountDrawer() {
  const patchTodo = mock(async () => {});
  const closeDetail = mock(() => {});
  renderWithStore(<DetailDrawer />, {
    detail: { kind: 'todo', todo: todoFixture(), history: [], comments: [] },
    sections: [],
    handoffs: [],
    sessions: { available: false, reason: '테스트', list: [] },
    patchTodo,
    closeDetail,
  });
  return { patchTodo, closeDetail };
}

const titleButton = () => screen.getByRole('button', { name: '제목 수정: 원래 제목' });
const titleInput = () => screen.getByRole('textbox', { name: /제목 수정/ });

describe('DetailDrawer 제목 편집', () => {
  test('제목을 클릭하면 input 으로 전환된다', async () => {
    mountDrawer();
    await userEvent.click(titleButton());
    expect(titleInput()).toBeDefined();
  });

  // 커밋 경로를 onBlur 하나로 모아 둔 이유가 이것이다 (DetailDrawer.tsx 의 commitTitle 주석).
  // Enter 가 blur 로 빠지므로, 경로가 둘이면 같은 PATCH 가 두 번 나간다.
  test('Enter 는 PATCH 를 한 번만 보낸다', async () => {
    const { patchTodo } = mountDrawer();
    await userEvent.click(titleButton());
    await userEvent.clear(titleInput());
    await userEvent.type(titleInput(), '바뀐 제목{Enter}');
    expect(patchTodo).toHaveBeenCalledTimes(1);
    expect(patchTodo.mock.calls[0]).toEqual(['todo1', { title: '바뀐 제목' }] as never);
  });

  test('Esc 는 저장하지 않고 원래 제목으로 되돌린다', async () => {
    const { patchTodo } = mountDrawer();
    await userEvent.click(titleButton());
    await userEvent.clear(titleInput());
    await userEvent.type(titleInput(), '버릴 제목{Escape}');
    expect(patchTodo).not.toHaveBeenCalled();
    expect(titleButton()).toBeDefined();
  });

  // 편집 중 Esc 는 편집 취소지 드로어 닫기가 아니다 — 전역 keydown 리스너까지 올라가면
  // 안내한 "Esc 취소"와 다른 동작이 된다.
  test('편집 중 Esc 는 드로어를 닫지 않는다', async () => {
    const { closeDetail } = mountDrawer();
    await userEvent.click(titleButton());
    await userEvent.type(titleInput(), '{Escape}');
    expect(closeDetail).not.toHaveBeenCalled();
  });

  test('빈 제목은 저장하지 않는다', async () => {
    const { patchTodo } = mountDrawer();
    await userEvent.click(titleButton());
    await userEvent.clear(titleInput());
    await userEvent.type(titleInput(), '   {Enter}');
    expect(patchTodo).not.toHaveBeenCalled();
    expect(titleButton()).toBeDefined();
  });
});

describe('DetailDrawer 미착수 핸드오프', () => {
  function handoffFixture(over: Partial<HandoffView> = {}): HandoffView {
    return {
      id: 'h1',
      todoId: 'todo1',
      sessionId: 'sess-1',
      sessionName: 'eelpout-a3',
      note: '',
      actor: 'logan',
      status: 'delivered',
      createdAt: '2026-07-27T00:00:00.000Z',
      deliveredAt: '2026-07-27T00:00:01.000Z',
      deliveredVia: 'stop',
      phase: 'delivered',
      unstarted: true,
      stale: false,
      ...over,
    };
  }

  function mountWith(handoffs: HandoffView[]) {
    const fetchSessions = mock(async () => {});
    renderWithStore(<DetailDrawer />, {
      detail: { kind: 'todo', todo: todoFixture(), history: [], comments: [] },
      sections: [],
      handoffs,
      sessions: { available: false, reason: '테스트', list: [] },
      fetchSessions,
    });
    return { fetchSessions };
  }

  const unstartedNotice = () => screen.queryByRole('status');

  test('집어가 놓고 안 한 건을 세션 이름과 함께 알린다', () => {
    mountWith([handoffFixture()]);
    expect(unstartedNotice()?.textContent).toContain('eelpout-a3');
    expect(unstartedNotice()?.textContent).toContain('착수하지 않았다');
  });

  test('착수한 건은 알리지 않는다', () => {
    mountWith([handoffFixture({ phase: 'accepted', unstarted: false })]);
    expect(unstartedNotice()).toBeNull();
  });

  // 이미 다시 보낸 상태라면 과거를 들출 이유가 없다.
  test('대기 중인 새 요청이 있으면 미착수 알림을 띄우지 않는다', () => {
    mountWith([
      handoffFixture(),
      handoffFixture({ id: 'h2', status: 'pending', phase: 'pending', unstarted: false }),
    ]);
    expect(unstartedNotice()).toBeNull();
  });

  // 같은 세션으로 되쏘지 않는다 — 그 세션은 사라졌을 수 있다. 패널을 열어 고르게 한다.
  test('다시 보내기는 세션 목록을 불러 보내기 패널을 연다', async () => {
    const { fetchSessions } = mountWith([handoffFixture()]);
    await userEvent.click(screen.getByRole('button', { name: '다시 보내기' }));
    expect(fetchSessions).toHaveBeenCalledTimes(1);
  });
});
