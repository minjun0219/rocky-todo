import { describe, expect, test } from 'bun:test';
import {
  COPY_FEEDBACK_MS,
  type CopyRefDocument,
  type CopyRefTextArea,
  copyRef,
  copyRefWithFeedback,
} from './lib';

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
    // expect 가 먼저 throw 해도 전역이 원상복구되도록 try/finally 로 감싼다 — 안 그러면
    // 이 테스트 실패 시 mutate 된 navigator 가 이후 테스트로 새어나간다.
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    try {
      expect(await copyRef('rocky#12')).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true });
    }
  });
});

describe('copyRefWithFeedback', () => {
  test('복사 성공 시 copied 플래그를 세우고, COPY_FEEDBACK_MS 뒤 타이머로 지운다', async () => {
    const copiedCalls: boolean[] = [];
    const scheduled: Array<{ handler: () => void; ms: number }> = [];

    await copyRefWithFeedback('rocky#12', (copied) => copiedCalls.push(copied), {
      clipboard: {
        writeText: async () => {},
      },
      setTimeout: (handler, ms) => {
        scheduled.push({ handler, ms });
        return 0;
      },
    });

    expect(copiedCalls).toEqual([true]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.ms).toBe(COPY_FEEDBACK_MS);

    // 타이머를 직접 굴려 "그 뒤 지운다" 쪽도 확인 — 실제 1200ms 를 기다리지 않는다.
    scheduled[0]?.handler();
    expect(copiedCalls).toEqual([true, false]);
  });

  test('clipboard/document 둘 다 없어 복사에 실패하면 prompt 폴백을 띄우고 copied 는 세우지 않는다', async () => {
    const copiedCalls: boolean[] = [];
    const promptCalls: Array<{ message: string; defaultValue: string | undefined }> = [];

    await copyRefWithFeedback('rocky#12', (copied) => copiedCalls.push(copied), {
      prompt: (message, defaultValue) => {
        promptCalls.push({ message, defaultValue });
        return null;
      },
    });

    expect(copiedCalls).toEqual([]);
    expect(promptCalls).toEqual([
      {
        message: '클립보드에 접근할 수 없다 — 아래 텍스트를 직접 복사해라:',
        defaultValue: 'rocky#12',
      },
    ]);
  });

  test('execCommand 폴백도 실패하면(false 반환) prompt 로 내려간다', async () => {
    const { document } = makeFakeDocument({ execCommandResult: false });
    const copiedCalls: boolean[] = [];
    const promptCalls: string[] = [];

    await copyRefWithFeedback('rocky#12', (copied) => copiedCalls.push(copied), {
      document,
      prompt: (message) => {
        promptCalls.push(message);
        return null;
      },
    });

    expect(copiedCalls).toEqual([]);
    expect(promptCalls).toEqual(['클립보드에 접근할 수 없다 — 아래 텍스트를 직접 복사해라:']);
  });
});
