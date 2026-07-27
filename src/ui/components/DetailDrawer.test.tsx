import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
