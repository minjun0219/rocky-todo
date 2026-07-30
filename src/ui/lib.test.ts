import { describe, expect, test } from 'bun:test';
import { DETAIL_HISTORY_EXCLUDED as STORE_DETAIL_HISTORY_EXCLUDED } from '../store';
import type { Comment, HistoryEntry } from '../store';
import type { TodoView } from '../refs';
import {
  boardCommand,
  COPY_FEEDBACK_MS,
  DETAIL_HISTORY_EXCLUDED,
  doingWarning,
  formatStamp,
  hasUnreadComments,
  isEditableTarget,
  markSeen,
  mergeTimeline,
  readSeen,
  STALE_MS,
  type CopyRefDocument,
  type CopyRefTextArea,
  type SeenStorage,
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

describe('isEditableTarget', () => {
  test('input / textarea / select 는 편집 중으로 본다', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input', 'textarea', 'select']) {
      expect(isEditableTarget({ tagName } as unknown as EventTarget)).toBe(true);
    }
  });

  test('contentEditable 요소도 편집 중으로 본다', () => {
    expect(
      isEditableTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget),
    ).toBe(true);
  });

  test('일반 요소와 null 은 아니다', () => {
    expect(isEditableTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false);
    expect(isEditableTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

function history(partial: Partial<HistoryEntry>): HistoryEntry {
  return {
    id: 1,
    entity: 'todo',
    entityId: 'abcd1234',
    actor: 'logan',
    action: 'update',
    at: '2026-07-26T01:00:00.000Z',
    ...partial,
  };
}

function comment(partial: Partial<Comment>): Comment {
  return {
    id: 'c1',
    todoId: 'abcd1234',
    actor: 'logan',
    body: '본문',
    createdAt: '2026-07-26T02:00:00.000Z',
    updatedAt: '2026-07-26T02:00:00.000Z',
    ...partial,
  };
}

/** localStorage 대신 쓰는 인메모리 저장소. */
function fakeStorage(
  initial: Record<string, string> = {},
): SeenStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe('mergeTimeline', () => {
  test('merges newest first', () => {
    const items = mergeTimeline(
      [
        history({ id: 2, at: '2026-07-26T03:00:00.000Z' }),
        history({ id: 1, at: '2026-07-26T01:00:00.000Z' }),
      ],
      [comment({ id: 'c1', createdAt: '2026-07-26T02:00:00.000Z' })],
    );
    expect(items.map((i) => i.at)).toEqual([
      '2026-07-26T03:00:00.000Z',
      '2026-07-26T02:00:00.000Z',
      '2026-07-26T01:00:00.000Z',
    ]);
    expect(items[1]?.kind).toBe('comment');
  });

  test('drops comment/comment-edit history rows (card-represented) but keeps comment-archive/comment-unarchive (card is gone)', () => {
    const items = mergeTimeline(
      [
        history({ id: 3, action: 'comment' }),
        history({ id: 4, action: 'comment-edit' }),
        history({ id: 5, action: 'comment-archive' }),
        history({ id: 6, action: 'comment-unarchive' }),
        history({ id: 7, action: 'done' }),
      ],
      [],
    );
    expect(items.map((i) => (i.kind === 'history' ? i.entry.action : i.kind))).toEqual([
      'comment-archive',
      'comment-unarchive',
      'done',
    ]);
  });
});

describe('DETAIL_HISTORY_EXCLUDED drift guard (finding B)', () => {
  test('the browser-safe copy in ./lib matches src/store.ts exactly', () => {
    // 두 파일이 독립적으로 export 하는 같은 값 쌍이다(브라우저 번들 제약 때문에 하나로
    // 합칠 수 없다 — 각 선언부 JSDoc 참고). 셋째 액션이 추가될 때 한쪽만 고치는 걸
    // 막는 게 이 테스트의 목적이다.
    expect([...DETAIL_HISTORY_EXCLUDED].sort()).toEqual([...STORE_DETAIL_HISTORY_EXCLUDED].sort());
  });
});

describe('formatStamp', () => {
  test('shows only the time for today', () => {
    const now = new Date(2026, 6, 26, 15, 0);
    const at = new Date(2026, 6, 26, 9, 5);
    expect(formatStamp(at.toISOString(), now)).toBe('09:05');
  });

  test('shows month-day and time for other days', () => {
    const now = new Date(2026, 6, 26, 15, 0);
    const at = new Date(2026, 6, 24, 18, 30);
    expect(formatStamp(at.toISOString(), now)).toBe('07-24 18:30');
  });
});

describe('seen cursor', () => {
  test('unread when there is a comment newer than the cursor', () => {
    const seen = { abcd1234: '2026-07-26T01:00:00.000Z' };
    expect(
      hasUnreadComments({ id: 'abcd1234', lastCommentAt: '2026-07-26T02:00:00.000Z' }, seen),
    ).toBe(true);
    expect(
      hasUnreadComments({ id: 'abcd1234', lastCommentAt: '2026-07-26T00:00:00.000Z' }, seen),
    ).toBe(false);
  });

  test('no comments means nothing unread', () => {
    expect(hasUnreadComments({ id: 'abcd1234' }, {})).toBe(false);
  });

  test('never seen but has a comment counts as unread', () => {
    expect(
      hasUnreadComments({ id: 'abcd1234', lastCommentAt: '2026-07-26T02:00:00.000Z' }, {}),
    ).toBe(true);
  });

  test('markSeen persists and readSeen survives malformed json', () => {
    const storage = fakeStorage();
    markSeen(storage, 'abcd1234', '2026-07-26T02:00:00.000Z');
    expect(readSeen(storage)).toEqual({ abcd1234: '2026-07-26T02:00:00.000Z' });

    const broken = fakeStorage({ 'rocky-todo-seen-comments': '{not json' });
    expect(readSeen(broken)).toEqual({});
  });

  test('readSeen drops non-string cursors and they read as unread', () => {
    const storage = fakeStorage({
      'rocky-todo-seen-comments': JSON.stringify({
        good: '2026-07-26T02:00:00.000Z',
        num: 1753490000000,
        obj: { at: '2026-07-26T02:00:00.000Z' },
        nul: null,
      }),
    });
    expect(readSeen(storage)).toEqual({ good: '2026-07-26T02:00:00.000Z' });

    // 걸러진 커서는 "본 적 없음" — 미확인으로 떨어져야 배지가 켜진다.
    const seen = readSeen(storage);
    expect(hasUnreadComments({ id: 'num', lastCommentAt: '2026-07-26T02:00:00.000Z' }, seen)).toBe(
      true,
    );
    expect(hasUnreadComments({ id: 'good', lastCommentAt: '2026-07-26T01:00:00.000Z' }, seen)).toBe(
      false,
    );
  });

  test('readSeen ignores a non-object payload', () => {
    expect(readSeen(fakeStorage({ 'rocky-todo-seen-comments': '["a"]' }))).toEqual({});
    expect(readSeen(fakeStorage({ 'rocky-todo-seen-comments': 'null' }))).toEqual({});
  });
});

describe('boardCommand', () => {
  test('참조를 보드 스킬 슬래시 커맨드로 감싼다', () => {
    expect(boardCommand('rocky-12')).toBe('/rocky-todo:board rocky-12');
  });

  test('글로벌 메모 참조도 같은 모양이다', () => {
    expect(boardCommand('note-3')).toBe('/rocky-todo:board note-3');
  });

  // 레거시 malformed board key 의 항목은 ref 가 raw id 로 폴백한다(`refOf`) — 그것도
  // 그대로 감싼다. 스킬은 raw id 도 참조 문법으로 받는다.
  test('raw id 폴백 ref 도 그대로 감싼다', () => {
    expect(boardCommand('921gvwnr')).toBe('/rocky-todo:board 921gvwnr');
  });
});

describe('doingWarning', () => {
  const NOW = Date.parse('2026-07-30T12:00:00.000Z');

  /** doing 인 todo — 검증에 쓰는 필드만 넘긴다. */
  function doing(over: Partial<TodoView> = {}): TodoView {
    return {
      id: 'todo1',
      number: 1,
      boardId: 'board1',
      title: 'x',
      description: '',
      status: 'doing',
      priority: 'p4',
      labels: [],
      links: [],
      doingBy: 'claude-code',
      doingSince: new Date(NOW - 60_000).toISOString(),
      position: 0,
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z',
      ref: 'rocky-todo-1',
      commentCount: 0,
      ...over,
    };
  }

  test('세션이 사라졌으면 가장 강한 경고다', () => {
    expect(doingWarning(doing({ doingState: 'gone' }), NOW)).toEqual({
      label: '세션 없음',
      title: '이 항목을 들고 있던 세션이 사라졌다',
      tone: 'dead',
    });
  });

  test('세션이 idle 이면 "멈춤" — 말을 걸면 이어지는 상태다', () => {
    expect(doingWarning(doing({ doingState: 'idle' }), NOW)?.tone).toBe('idle');
  });

  test('세션이 live 면 오래 걸려도 경고하지 않는다 — 시간 규칙보다 정확하다', () => {
    const long = doing({
      doingState: 'live',
      doingSince: new Date(NOW - STALE_MS - 60_000).toISOString(),
    });
    expect(doingWarning(long, NOW)).toBeNull();
  });

  test('판정이 없으면(구버전 데몬/unknown) 30분 규칙으로 물러난다', () => {
    const stale = doing({ doingSince: new Date(NOW - STALE_MS - 60_000).toISOString() });
    expect(doingWarning(stale, NOW)?.tone).toBe('slow');
    expect(doingWarning(doing({ doingState: 'unknown' }), NOW)).toBeNull();
  });

  test('막 시작한 항목은 조용하다', () => {
    expect(doingWarning(doing(), NOW)).toBeNull();
  });
});
