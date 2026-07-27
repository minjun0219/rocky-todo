import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { boardFixture, renderWithStore } from '../test-support';
import { Sidebar } from './Sidebar';

afterEach(cleanup);

/** 보드 하나가 있는 사이드바를 띄우고 createBoard 스파이를 돌려준다. */
function mountSidebar(createBoard: () => Promise<void>) {
  const spy = mock(createBoard);
  renderWithStore(<Sidebar />, {
    boards: [boardFixture()],
    todos: [],
    selected: 'all',
    setSelected: mock(() => {}),
    createBoard: spy as never,
  });
  return spy;
}

const openButton = () => screen.getByRole('button', { name: '+ 새 보드' });
const keyInput = () => screen.getByRole('textbox', { name: '새 보드 이름' });

describe('Sidebar 보드 생성 폼', () => {
  test('"+ 새 보드" 를 누르면 input 으로 전환된다', async () => {
    mountSidebar(async () => {});
    await userEvent.click(openButton());
    expect(keyInput()).toBeDefined();
  });

  test('Enter 로 생성하면 폼이 닫힌다', async () => {
    const createBoard = mountSidebar(async () => {});
    await userEvent.click(openButton());
    await userEvent.type(keyInput(), 'newboard{Enter}');
    expect(createBoard).toHaveBeenCalledTimes(1);
    expect(createBoard.mock.calls[0]).toEqual(['newboard'] as never);
    expect(openButton()).toBeDefined();
  });

  // 서버가 key 를 거절했을 때 조용히 닫으면 왜 안 만들어졌는지 알 수 없다.
  // 순수 함수로는 "이유가 화면에 남았는가" 를 증명할 수 없는 자리다.
  test('생성이 실패하면 사유를 알리고 입력을 유지한다', async () => {
    mountSidebar(async () => {
      throw new Error('board key cannot contain #');
    });
    await userEvent.click(openButton());
    await userEvent.type(keyInput(), 'bad#key{Enter}');

    expect(screen.getByRole('alert').textContent).toBe('board key cannot contain #');
    expect(keyInput()).toHaveProperty('value', 'bad#key');
  });

  test('다시 입력하면 이전 에러가 걷힌다', async () => {
    mountSidebar(async () => {
      throw new Error('board key cannot contain #');
    });
    await userEvent.click(openButton());
    await userEvent.type(keyInput(), 'bad#key{Enter}');
    await userEvent.type(keyInput(), 'x');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('Esc 는 생성하지 않고 폼을 닫는다', async () => {
    const createBoard = mountSidebar(async () => {});
    await userEvent.click(openButton());
    await userEvent.type(keyInput(), 'newboard{Escape}');
    expect(createBoard).not.toHaveBeenCalled();
    expect(openButton()).toBeDefined();
  });

  test('빈 입력으로 Enter 하면 만들지 않고 닫는다', async () => {
    const createBoard = mountSidebar(async () => {});
    await userEvent.click(openButton());
    await userEvent.type(keyInput(), '   {Enter}');
    expect(createBoard).not.toHaveBeenCalled();
    expect(openButton()).toBeDefined();
  });
});
