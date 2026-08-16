import { afterEach, describe, expect, test } from 'bun:test';
import { act, cleanup } from '@testing-library/react';
import { renderWithStore } from '../test-support';
import { ThermalStrip } from './ThermalStrip';

afterEach(cleanup);

const EVENTS = [
  { id: 2, actor: 'claude-code', at: '2026-08-16T12:00:00.000Z' }, // 최신 (API 는 최신순)
  { id: 1, actor: 'minjun', at: '2026-08-16T11:00:00.000Z' },
];

function mockHistory(rows: unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(rows))) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe('ThermalStrip', () => {
  test('왼쪽=과거·오른쪽=최신으로 뒤집고, 색은 두 대기를 따른다', async () => {
    const restore = mockHistory(EVENTS);
    try {
      await act(async () => {
        renderWithStore(<ThermalStrip />, {});
      });
      const ticks = [...document.querySelectorAll('[role="img"] span')];
      expect(ticks.length).toBe(2);
      // API 최신순 → 화면은 뒤집혀 [사람(과거), 에이전트(최신)] 순.
      expect((ticks[0] as HTMLElement).style.background).toContain('--cool');
      expect((ticks[1] as HTMLElement).style.background).toContain('--warm');
      // 최신이 가장 진하다.
      expect((ticks[1] as HTMLElement).style.opacity).toBe('1');
    } finally {
      restore();
    }
  });

  test('히스토리가 비면 아무것도 그리지 않는다', async () => {
    const restore = mockHistory([]);
    try {
      await act(async () => {
        renderWithStore(<ThermalStrip />, {});
      });
      expect(document.querySelector('[role="img"]')).toBeNull();
    } finally {
      restore();
    }
  });
});
