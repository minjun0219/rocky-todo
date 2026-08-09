import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Board } from '../../store';
import { useUiStore } from '../store';
import { boardFixture, renderWithStore } from '../test-support';
import { BoardHeader } from './BoardHeader';
import { TodoPane } from './TodoPane';

afterEach(cleanup);

type UpdateBoard = (boardKey: string, patch: Record<string, unknown>) => Promise<void>;

/** 보드 헤더를 띄우고 updateBoard 스파이를 돌려준다. */
function mountHeader(board: Partial<Board>, updateBoard: UpdateBoard = async () => {}) {
  const spy = mock(updateBoard);
  renderWithStore(<BoardHeader board={boardFixture(board)} />, {
    updateBoard: spy as never,
  });
  return spy;
}

const editButton = () => screen.getByRole('button', { name: '편집' });
const field = (name: string) => screen.getByRole('textbox', { name });

describe('BoardHeader 표시', () => {
  test('설명과 GitHub 링크를 보여준다', () => {
    mountHeader({ title: 'Tally', description: '가계부 앱', repo: 'minjun0219/tally' });
    expect(screen.getByText('가계부 앱')).toBeDefined();
    const link = screen.getByRole('link', { name: /minjun0219\/tally/ });
    expect(link.getAttribute('href')).toBe('https://github.com/minjun0219/tally');
  });

  // 옛 참조가 아직 살아 있다는 걸 사용자가 알 수 있는 유일한 자리다 — 다른 표면은
  // 언제나 새 key 만 내보낸다.
  test('옛 이름이 있으면 그것도 보여준다', () => {
    mountHeader({ key: 'tally', previousKeys: ['gotgan'] });
    expect(screen.getByText(/gotgan/)).toBeDefined();
  });
});

describe('BoardHeader 편집', () => {
  test('바뀐 필드만 한 번의 PATCH 로 보낸다', async () => {
    const updateBoard = mountHeader({ key: 'gotgan', title: 'gotgan' });
    await userEvent.click(editButton());
    await userEvent.clear(field('key'));
    await userEvent.type(field('key'), 'tally');
    await userEvent.type(field('설명'), '가계부 앱');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));

    expect(updateBoard).toHaveBeenCalledTimes(1);
    expect(updateBoard.mock.calls[0]).toEqual([
      'gotgan',
      { key: 'tally', description: '가계부 앱' },
    ]);
    // 성공하면 폼이 닫힌다
    expect(await screen.findByRole('button', { name: '편집' })).toBeDefined();
  });

  test('비운 값은 null 로 보낸다 — "지운다" 다', async () => {
    const updateBoard = mountHeader({ description: '옛 설명', repo: 'o/n' });
    await userEvent.click(editButton());
    await userEvent.clear(field('설명'));
    await userEvent.click(screen.getByRole('button', { name: '저장' }));

    expect(updateBoard.mock.calls[0]?.[1]).toEqual({ description: null });
  });

  test('아무것도 안 바꾸고 저장하면 요청을 보내지 않는다', async () => {
    const updateBoard = mountHeader({ title: 'Tally' });
    await userEvent.click(editButton());
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(updateBoard).not.toHaveBeenCalled();
  });

  // 서버가 key 를 거절했을 때(다른 보드가 쓰는 이름 등) 조용히 닫으면 왜 안 바뀌었는지
  // 알 수 없다 — 입력을 유지한 채 사유를 남긴다.
  test('저장이 실패하면 사유를 알리고 폼을 유지한다', async () => {
    mountHeader({ key: 'gotgan' }, async () => {
      throw new Error('board key already in use: tally');
    });
    await userEvent.click(editButton());
    await userEvent.clear(field('key'));
    await userEvent.type(field('key'), 'tally');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));

    expect((await screen.findByRole('alert')).textContent).toBe('board key already in use: tally');
    expect(field('key')).toHaveProperty('value', 'tally');
  });

  // 헤더에 `key` 가 없으면 React 가 같은 인스턴스를 재사용해 편집 상태와 입력값이 살아남고,
  // 그 상태로 저장하면 **새로 고른 보드**가 직전 보드의 값으로 덮어써진다(rename 포함).
  test('편집 중 보드를 바꾸면 편집 상태가 따라오지 않는다', async () => {
    const updateBoard = mock(async () => {});
    const gotgan = boardFixture({ id: 'b1', key: 'gotgan', title: 'gotgan' });
    const other = boardFixture({ id: 'b2', key: 'other', title: 'other' });
    const { rerender } = renderWithStore(<TodoPane />, {
      boards: [gotgan, other],
      todos: [],
      sections: [],
      selected: 'gotgan',
      updateBoard: updateBoard as never,
    });

    await userEvent.click(editButton());
    await userEvent.clear(field('key'));
    await userEvent.type(field('key'), 'stolen');

    // 사이드바에서 다른 보드로 전환한 것과 같은 상태 변화
    act(() => {
      useUiStore.setState({ selected: 'other' });
    });
    rerender(<TodoPane />);

    expect(screen.queryByRole('textbox', { name: 'key' })).toBeNull();
    expect(screen.getByRole('button', { name: '편집' })).toBeDefined();
    expect(updateBoard).not.toHaveBeenCalled();
  });

  test('취소는 아무것도 보내지 않고 닫는다', async () => {
    const updateBoard = mountHeader({ title: 'Tally' });
    await userEvent.click(editButton());
    await userEvent.clear(field('이름'));
    await userEvent.type(field('이름'), '다른 이름');
    await userEvent.click(screen.getByRole('button', { name: '취소' }));

    expect(updateBoard).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '편집' })).toBeDefined();
  });
});
