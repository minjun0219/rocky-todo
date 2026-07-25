import { describe, expect, test } from 'bun:test';
import { copyRef } from './lib';

describe('copyRef', () => {
  test('navigator.clipboard 가 있으면 그것을 쓴다', async () => {
    const written: string[] = [];
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        clipboard: {
          writeText: async (t: string) => {
            written.push(t);
          },
        },
      },
      configurable: true,
    });
    expect(await copyRef('rocky#12')).toBe(true);
    expect(written).toEqual(['rocky#12']);
    Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true });
  });

  test('clipboard 가 없으면 false 를 돌려준다 (호출자가 폴백을 띄운다)', async () => {
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    expect(await copyRef('rocky#12')).toBe(false);
    Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true });
  });
});
