import { describe, expect, test } from 'bun:test';
import { formatNextCandidates, NEXT_DEFAULT_LIMIT, rankNext, toJsonCandidates } from './next';
import type { TodoView } from './refs';

/** 기준 시각 — 2026-07-30 09:00 로컬. 마감 라벨은 이 날짜를 "오늘" 로 읽는다. */
const NOW = new Date(2026, 6, 30, 9, 0, 0).getTime();

let seq = 0;

function todo(overrides: Partial<TodoView> = {}): TodoView {
  seq += 1;
  return {
    id: `t${seq}`,
    number: seq,
    boardId: 'b1',
    title: `할 일 ${seq}`,
    description: '',
    status: 'todo',
    priority: 'p4',
    labels: [],
    links: [],
    position: seq,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ref: `rocky-${seq}`,
    commentCount: 0,
    ...overrides,
  };
}

function refs(candidates: ReturnType<typeof rankNext>): string[] {
  return candidates.map((c) => c.todo.ref);
}

describe('rankNext — 후보에서 빠지는 것', () => {
  test('done 과 보관된 항목은 후보가 아니다', () => {
    const open = todo();
    const ranked = rankNext(
      [open, todo({ status: 'done' }), todo({ archivedAt: '2026-07-20T00:00:00.000Z' })],
      { now: NOW },
    );
    expect(refs(ranked)).toEqual([open.ref]);
  });

  test('살아 있는 세션이 붙들고 있는 doing 은 후보가 아니다', () => {
    const open = todo();
    const held = todo({ status: 'doing', doingBy: 'claude-code', doingState: 'live' });
    expect(refs(rankNext([open, held], { now: NOW }))).toEqual([open.ref]);
  });

  test('열린 자식을 가진 부모(우산 항목)는 빠지고 자식이 남는다', () => {
    const parent = todo({ priority: 'p1' });
    const child = todo({ parentId: parent.id });
    expect(refs(rankNext([parent, child], { now: NOW }))).toEqual([child.ref]);
  });

  test('자식이 전부 done 인 부모는 남는다 — 마무리가 남았다', () => {
    const parent = todo();
    const child = todo({ parentId: parent.id, status: 'done' });
    expect(refs(rankNext([parent, child], { now: NOW }))).toEqual([parent.ref]);
  });
});

describe('rankNext — 순서', () => {
  test('주인 없는 doing 이 p1 보다 위다', () => {
    const urgent = todo({ priority: 'p1' });
    const orphan = todo({ status: 'doing', doingBy: 'claude-code', doingState: 'gone' });
    expect(refs(rankNext([urgent, orphan], { now: NOW }))).toEqual([orphan.ref, urgent.ref]);
  });

  test('세션 없음(gone)이 멈춤(idle)보다 위다', () => {
    const idle = todo({ status: 'doing', doingBy: 'claude-code', doingState: 'idle' });
    const gone = todo({ status: 'doing', doingBy: 'claude-code', doingState: 'gone' });
    expect(refs(rankNext([idle, gone], { now: NOW }))).toEqual([gone.ref, idle.ref]);
  });

  test('주인 없는 doing 은 하위 범주가 다 쌓여도 밀리지 않는다', () => {
    // 리뷰 반례: 합산 점수였을 때 `gone` p4(100) 가 마감 지난 p1 + 최근 댓글(112) 에 밀렸다.
    const orphan = todo({ priority: 'p4', status: 'doing', doingState: 'gone' });
    const loaded = todo({
      priority: 'p1',
      due: '2026-07-20',
      lastCommentAt: '2026-07-30T08:00:00.000Z',
    });
    expect(refs(rankNext([loaded, orphan], { now: NOW }))).toEqual([orphan.ref, loaded.ref]);
  });

  test('마감은 우선순위·최근 댓글이 다 쌓여도 이긴다', () => {
    const due = todo({ priority: 'p4', due: '2026-08-05' });
    const loaded = todo({ priority: 'p1', lastCommentAt: '2026-07-30T08:00:00.000Z' });
    expect(refs(rankNext([loaded, due], { now: NOW }))).toEqual([due.ref, loaded.ref]);
  });

  test('판정 불가한 진행중은 마감 아래, 우선순위 위다', () => {
    const due = todo({ priority: 'p4', due: '2026-08-05' });
    const inProgress = todo({ priority: 'p4', status: 'doing', doingBy: 'logan' });
    const urgent = todo({ priority: 'p1' });
    expect(refs(rankNext([urgent, inProgress, due], { now: NOW }))).toEqual([
      due.ref,
      inProgress.ref,
      urgent.ref,
    ]);
  });

  test('마감이 지난 항목이 p1 보다 위다', () => {
    const urgent = todo({ priority: 'p1' });
    const overdue = todo({ priority: 'p4', due: '2026-07-28' });
    expect(refs(rankNext([urgent, overdue], { now: NOW }))).toEqual([overdue.ref, urgent.ref]);
  });

  test('우선순위 내림차순 — p1 → p2 → p3 → p4', () => {
    const p4 = todo({ priority: 'p4' });
    const p2 = todo({ priority: 'p2' });
    const p1 = todo({ priority: 'p1' });
    const p3 = todo({ priority: 'p3' });
    expect(refs(rankNext([p4, p2, p1, p3], { now: NOW }))).toEqual([
      p1.ref,
      p2.ref,
      p3.ref,
      p4.ref,
    ]);
  });

  test('동점은 position → number 로 결정적으로 갈린다', () => {
    const later = todo({ position: 9 });
    const earlier = todo({ position: 2 });
    expect(refs(rankNext([later, earlier], { now: NOW }))).toEqual([earlier.ref, later.ref]);
  });

  test('limit 은 상위 N 개만 남긴다', () => {
    const items = [todo({ priority: 'p1' }), todo({ priority: 'p2' }), todo({ priority: 'p3' })];
    expect(rankNext(items, { now: NOW, limit: 2 })).toHaveLength(2);
    expect(rankNext(items, { now: NOW })).toHaveLength(3);
  });
});

describe('rankNext — 근거 라벨', () => {
  test('마감은 D-day / D-n / D+n 으로 읽힌다', () => {
    const reasonOf = (due: string) => rankNext([todo({ due })], { now: NOW })[0]?.reason;
    expect(reasonOf('2026-07-30')).toBe('마감 D-day');
    expect(reasonOf('2026-08-02')).toBe('마감 D-3');
    expect(reasonOf('2026-07-27')).toBe('마감 D+3');
  });

  test('마감이 멀면 라벨이 붙지 않는다', () => {
    expect(rankNext([todo({ due: '2026-12-25' })], { now: NOW })[0]?.reason).toBe('대기 중');
  });

  test('p3/p4 는 우선순위를 근거로 찍지 않는다', () => {
    expect(rankNext([todo({ priority: 'p2' })], { now: NOW })[0]?.reason).toBe('p2');
    expect(rankNext([todo({ priority: 'p3' })], { now: NOW })[0]?.reason).toBe('대기 중');
  });

  test('근거는 강한 것부터 이어 붙는다', () => {
    const item = todo({
      status: 'doing',
      doingBy: 'claude-code',
      doingState: 'idle',
      priority: 'p2',
      due: '2026-07-31',
      lastCommentAt: '2026-07-30T08:00:00.000Z',
    });
    expect(rankNext([item], { now: NOW })[0]?.reason).toBe(
      '이어받기(멈춤) · 마감 D-1 · p2 · 최근 댓글',
    );
  });

  test('오래된 댓글은 근거가 아니다', () => {
    const stale = todo({ lastCommentAt: '2026-07-01T00:00:00.000Z' });
    expect(rankNext([stale], { now: NOW })[0]?.reason).toBe('대기 중');
  });

  test('판정 불가한 doing 은 이어받기라고 부르지 않는다', () => {
    const human = todo({ status: 'doing', doingBy: 'logan', doingState: 'unknown' });
    expect(rankNext([human], { now: NOW })[0]?.reason).toBe('진행중(logan)');
  });
});

describe('rankNext — 깨진 입력', () => {
  test('망가진 due 는 0점으로 흘리고 던지지 않는다', () => {
    const broken = todo({ due: '2026-6' });
    const ranked = rankNext([broken], { now: NOW });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.reason).toBe('대기 중');
  });

  test('달력에 없는 날짜는 마감으로 세지 않는다 — Date.UTC 가 굴려 버리는 값들', () => {
    // due 는 어디서도 검증되지 않는 자유 문자열이라 실제로 저장될 수 있다.
    // 2026-02-31 → 3월 3일, 2026-13-01 → 2027년 1월 1일로 굴러가 엉뚱한 D-day 가 찍혔다.
    const reasonOf = (due: string) => rankNext([todo({ due })], { now: NOW })[0]?.reason;
    expect(reasonOf('2026-02-31')).toBe('대기 중');
    expect(reasonOf('2026-13-01')).toBe('대기 중');
    expect(reasonOf('2026-00-10')).toBe('대기 중');
    // 경계: 실재하는 날짜(윤년 2월 29일 포함)는 그대로 마감으로 세어져야 한다.
    expect(reasonOf('2026-02-28')).toContain('마감 D+');
    expect(reasonOf('2024-02-29')).toContain('마감 D+');
  });

  test('마감 지남 판정은 실재하는 날짜에서만 나온다', () => {
    expect(rankNext([todo({ due: '2026-07-31' })], { now: NOW })[0]?.reason).toBe('마감 D-1');
    // 같은 자리수인데 달력에 없는 값 — 위와 달리 아무 라벨도 붙지 않아야 한다.
    expect(rankNext([todo({ due: '2026-07-32' })], { now: NOW })[0]?.reason).toBe('대기 중');
  });

  test('빈 보드는 빈 배열', () => {
    expect(rankNext([], { now: NOW })).toEqual([]);
  });
});

describe('toJsonCandidates — payload 는 컴팩트해야 한다', () => {
  const keyOf = (id: string) => (id === 'b1' ? 'rocky-todo' : undefined);

  test('TodoView 전체가 아니라 고를 때 필요한 필드만 나간다', () => {
    const item = todo({ title: '오리진 검사', priority: 'p2', description: '본문' });
    const [row] = toJsonCandidates(rankNext([item], { now: NOW }), keyOf);
    expect(row).toEqual({
      ref: item.ref,
      number: item.number,
      board: 'rocky-todo',
      title: '오리진 검사',
      reason: 'p2',
      priority: 'p2',
      status: 'todo',
      due: undefined,
      labels: [],
      commentCount: 0,
      summary: '본문',
    });
    // 커맨드가 쓰지 않는 무거운 필드는 실리지 않는다 — 이게 응답 지연의 원인이었다.
    expect(row).not.toHaveProperty('description');
    expect(row).not.toHaveProperty('links');
    expect(row).not.toHaveProperty('doingSessionId');
  });

  test('summary 는 여러 줄을 한 줄로 눌러 160자까지 자른다', () => {
    const long = todo({ description: `첫 줄\n\n${'가'.repeat(300)}` });
    const [row] = toJsonCandidates(rankNext([long], { now: NOW }), keyOf);
    expect(row?.summary).toStartWith('첫 줄 가가가');
    expect(row?.summary).toEndWith('…');
    expect(row?.summary?.length).toBe(161); // 160자 + 말줄임표
  });

  test('description 이 비면 summary 필드 자체가 없다', () => {
    const [row] = toJsonCandidates(rankNext([todo({ description: '' })], { now: NOW }), keyOf);
    expect(row?.summary).toBeUndefined();
  });

  test('board key 를 못 찾아도 던지지 않고 빈 문자열로 둔다', () => {
    const orphanBoard = todo({ boardId: 'unknown' });
    const [row] = toJsonCandidates(rankNext([orphanBoard], { now: NOW }), keyOf);
    expect(row?.board).toBe('');
  });
});

describe('formatNextCandidates', () => {
  test('한 줄에 ref · 제목 · 근거', () => {
    const ranked = rankNext([todo({ title: '오리진 검사', priority: 'p2' })], { now: NOW });
    expect(formatNextCandidates(ranked)).toBe(`1. ${ranked[0]?.todo.ref}  오리진 검사  — p2`);
  });

  test('개행이 든 제목도 한 줄로 눌린다 — 한 줄 = 후보 하나', () => {
    // 제목은 어디서도 다듬어지지 않는다(REST 는 빈 문자열만 거부, MCP 는 z.string()).
    // 그대로 보간하면 후보 하나가 여러 줄로 쪼개져 사용자가 고른 번호와 ref 가 어긋난다.
    const nasty = todo({ title: '앞줄\n2. 가짜 후보\t뒤줄' });
    const out = formatNextCandidates(rankNext([nasty], { now: NOW }));
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toContain('앞줄 2. 가짜 후보 뒤줄');
  });

  test('후보가 없으면 이유를 말한다', () => {
    expect(formatNextCandidates([])).toContain('후보가 없다');
  });

  test('기본 후보 수는 한 화면에서 훑을 만큼이다', () => {
    expect(NEXT_DEFAULT_LIMIT).toBe(8);
  });
});
