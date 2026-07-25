import { describe, expect, test } from 'bun:test';
import { type CopyRefDocument, type CopyRefTextArea, copyRef } from './lib';

/** copyRef 의 execCommand 폴백 경로를 DOM 없이 검증하기 위한 fake document. */
function makeFakeDocument(
  options: { execCommandResult?: boolean; execCommandThrows?: boolean } = {},
) {
  const calls: { appended: CopyRefTextArea[]; removed: CopyRefTextArea[]; execCommand: string[] } =
    {
      appended: [],
      removed: [],
      execCommand: [],
    };
  const document: CopyRefDocument = {
    createElement: (tagName) => {
      expect(tagName).toBe('textarea');
      const el: CopyRefTextArea = {
        value: '',
        style: { position: '', opacity: '' },
        setAttribute: () => {},
        select: () => {},
      };
      return el;
    },
    body: {
      appendChild: (node) => {
        calls.appended.push(node);
      },
      removeChild: (node) => {
        calls.removed.push(node);
      },
    },
    execCommand: (command) => {
      calls.execCommand.push(command);
      if (options.execCommandThrows) {
        throw new Error('execCommand 거부됨');
      }
      return options.execCommandResult ?? true;
    },
  };
  return { document, calls };
}

describe('copyRef', () => {
  test('navigator.clipboard 가 있으면 그것을 쓴다', async () => {
    const written: string[] = [];
    const ok = await copyRef('rocky#12', {
      clipboard: {
        writeText: async (t: string) => {
          written.push(t);
        },
      },
    });
    expect(ok).toBe(true);
    expect(written).toEqual(['rocky#12']);
  });

  test('clipboard 도 document 도 없으면 false 를 돌려준다 (호출자가 수동 복사 안내를 띄운다)', async () => {
    expect(await copyRef('rocky#12', {})).toBe(false);
  });

  test('clipboard 가 없고 document 가 있으면 execCommand 폴백을 쓴다 (LAN 평문 HTTP)', async () => {
    const { document, calls } = makeFakeDocument({ execCommandResult: true });
    const ok = await copyRef('rocky#12', { document });
    expect(ok).toBe(true);
    expect(calls.appended).toHaveLength(1);
    expect(calls.appended[0]?.value).toBe('rocky#12');
    expect(calls.execCommand).toEqual(['copy']);
    expect(calls.removed).toEqual(calls.appended);
  });

  test('execCommand 가 false 를 돌려주면 그 결과를 그대로 전달한다', async () => {
    const { document, calls } = makeFakeDocument({ execCommandResult: false });
    const ok = await copyRef('rocky#12', { document });
    expect(ok).toBe(false);
    expect(calls.removed).toHaveLength(1);
  });

  test('clipboard.writeText 가 거부되면 (권한 거부) document 폴백으로 내려간다', async () => {
    const { document, calls } = makeFakeDocument({ execCommandResult: true });
    const ok = await copyRef('rocky#12', {
      clipboard: {
        writeText: async () => {
          throw new Error('permission denied');
        },
      },
      document,
    });
    expect(ok).toBe(true);
    expect(calls.execCommand).toEqual(['copy']);
  });

  test('execCommand 가 throw 하면 false 를 돌려주고, 그래도 textarea 는 제거한다', async () => {
    const { document, calls } = makeFakeDocument({ execCommandThrows: true });
    const ok = await copyRef('rocky#12', { document });
    expect(ok).toBe(false);
    expect(calls.appended).toHaveLength(1);
    expect(calls.removed).toEqual(calls.appended);
  });

  test('인자를 하나만 넘기면 실제 전역(navigator/document)을 기본값으로 쓴다', async () => {
    // Bun 테스트 런타임에는 DOM 이 없어 document 가 없다 — clipboard 도 없으면 false.
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    expect(await copyRef('rocky#12')).toBe(false);
    Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true });
  });
});
