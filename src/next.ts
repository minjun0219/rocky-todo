/**
 * "다음에 뭘 할까" 후보 랭킹 — 순수 함수.
 *
 * 보드를 그대로 들이밀면 고를 수 없다(실사용 보드가 이미 30건대다). 게다가 이걸 쓰는
 * 슬래시 커맨드의 선택지 UI 는 한 번에 넉넉히 4개라, **목록을 좁히는 판정**이 먼저 있어야
 * 한다. 그 판정을 출력 포맷·CLI 에서 떼어 둔 이유는 조합이 많아서다 — 상태 × 마감 ×
 * 우선순위 × 계층을 주입 없이 테스트하려면 순수해야 한다(`./doing` 과 같은 이유).
 *
 * 여기서 하지 않는 것: 세션 대조. `doingState` 는 서버가 이미 `GET /api/todos` 응답에
 * 얹어 준다(`./doing` 의 `resolveDoingState`). 이 모듈은 그 판정을 **소비**만 한다.
 */

import type { TodoView } from './refs';

/** 후보 하나 — 랭킹 점수와 사람이 읽는 근거를 얹는다. */
export interface NextCandidate {
  todo: TodoView;
  score: number;
  /** 왜 위로 왔는지 (예: `이어받기(멈춤) · p2`). 선택지 설명에 그대로 쓴다. */
  reason: string;
}

export interface RankNextOptions {
  /** 기준 시각(ms) — 마감 D-day 계산의 "오늘". 테스트가 고정한다. */
  now: number;
  /** 상위 몇 개까지 남길지. 생략하면 전부. */
  limit?: number;
}

/**
 * CLI 가 기본으로 보여줄 후보 수.
 *
 * 선택지 UI 가 4개까지라 고르는 것은 상위 4개지만, 그 위에 무엇이 밀려났는지 보이지 않으면
 * "왜 이 4개인가" 를 사람이 검증할 수 없다. 그래서 목록은 두 배까지 보여준다.
 */
export const NEXT_DEFAULT_LIMIT = 8;

const PRIORITY_SCORE: Record<TodoView['priority'], number> = { p1: 30, p2: 18, p3: 6, p4: 0 };
const PRIORITY_ORDER: Record<TodoView['priority'], number> = { p1: 0, p2: 1, p3: 2, p4: 3 };

/** 마감이 코앞이라고 볼 기간(일). 이 안쪽만 점수를 받는다. */
const DUE_SOON_DAYS = 7;
/** 댓글이 "방금 오갔다" 고 볼 기간(일). 사용자가 보드에서 답을 달았을 가능성이 높은 구간. */
const FRESH_COMMENT_DAYS = 3;

const DAY_MS = 86_400_000;

/** 열려 있는가 — done/보관은 후보가 아니다. */
function isOpen(todo: TodoView): boolean {
  return todo.status !== 'done' && !todo.archivedAt;
}

/** `YYYY-MM-DD` → 에포크 기준 일수. 자리 파싱이라 파싱 타임존에 흔들리지 않는다. */
function dayNumber(date: string): number {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) {
    return Number.NaN;
  }
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** 기준 시각의 **로컬** 날짜를 같은 일수 축으로 옮긴다 — 마감은 사람이 사는 날짜다. */
function todayNumber(now: number): number {
  const t = new Date(now);
  return Math.floor(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) / DAY_MS);
}

interface Scored {
  score: number;
  labels: string[];
}

/**
 * 마감 점수 — 지난 것 > 오늘 > 코앞. 마감이 없거나 깨진 값이면 0점이고 라벨도 없다.
 *
 * 깨진 `due` 를 0점으로 흘리는 것은 의도다. 여기서 던지면 항목 하나의 오타가 "다음 작업"
 * 전체를 못 쓰게 만든다 — 랭킹은 조언이고, 조언은 최악의 입력에서도 나와야 한다.
 */
function dueScore(todo: TodoView, now: number): Scored {
  if (!todo.due) {
    return { score: 0, labels: [] };
  }
  const days = dayNumber(todo.due) - todayNumber(now);
  if (Number.isNaN(days)) {
    return { score: 0, labels: [] };
  }
  if (days < 0) {
    return { score: 70, labels: [`마감 D+${-days}`] };
  }
  if (days === 0) {
    return { score: 60, labels: ['마감 D-day'] };
  }
  return days <= DUE_SOON_DAYS
    ? { score: 35, labels: [`마감 D-${days}`] }
    : { score: 0, labels: [] };
}

/**
 * 진행중 점수 — **주인 없는 doing 이 가장 위**다.
 *
 * 이 순서가 랭킹의 핵심이다. 새 일을 하나 더 벌이는 것보다 "누군가 시작해 놓고 끊긴 것"
 * 을 잇는 편이 거의 항상 낫다. `live`(세션이 지금 그걸 붙들고 있음)는 후보에서 아예
 * 빠지므로 여기 오지 않는다 — 두 에이전트가 한 항목을 같이 잡는 사고를 막는 자리다.
 */
function doingScore(todo: TodoView): Scored {
  if (todo.status !== 'doing') {
    return { score: 0, labels: [] };
  }
  if (todo.doingState === 'gone') {
    return { score: 100, labels: ['이어받기(세션 없음)'] };
  }
  if (todo.doingState === 'idle') {
    return { score: 90, labels: ['이어받기(멈춤)'] };
  }
  // 판정 불가(`unknown`) 나 사람이 잡은 doing. 죽었다고 단정할 수 없으니 "이어받기" 라고
  // 부르지 않되, todo 보다는 위에 둔다 — 이미 손댄 일이다.
  return { score: 45, labels: [todo.doingBy ? `진행중(${todo.doingBy})` : '진행중'] };
}

/** 우선순위 점수. 라벨은 p1/p2 만 — p3/p4 까지 찍으면 근거 줄이 소음이 된다. */
function priorityScore(todo: TodoView): Scored {
  const score = PRIORITY_SCORE[todo.priority];
  return { score, labels: todo.priority === 'p1' || todo.priority === 'p2' ? [todo.priority] : [] };
}

/** 최근 댓글 점수 — 보드에서 대화가 오가는 중이면 그쪽이 대개 지금 관심사다. */
function commentScore(todo: TodoView, now: number): Scored {
  if (!todo.lastCommentAt) {
    return { score: 0, labels: [] };
  }
  const at = Date.parse(todo.lastCommentAt);
  if (Number.isNaN(at) || now - at > FRESH_COMMENT_DAYS * DAY_MS) {
    return { score: 0, labels: [] };
  }
  return { score: 12, labels: ['최근 댓글'] };
}

function scoreOf(todo: TodoView, now: number): Scored {
  const parts = [
    doingScore(todo),
    dueScore(todo, now),
    priorityScore(todo),
    commentScore(todo, now),
  ];
  return {
    score: parts.reduce((sum, part) => sum + part.score, 0),
    labels: parts.flatMap((part) => part.labels),
  };
}

/**
 * 점수 내림차순. 동점은 우선순위 → position → number → ref 로 완전히 결정된다 —
 * 같은 보드를 두 번 물었을 때 순서가 흔들리면 사용자가 1번을 신뢰할 수 없다.
 */
function compareCandidates(a: NextCandidate, b: NextCandidate): number {
  return (
    b.score - a.score ||
    PRIORITY_ORDER[a.todo.priority] - PRIORITY_ORDER[b.todo.priority] ||
    a.todo.position - b.todo.position ||
    a.todo.number - b.todo.number ||
    a.todo.ref.localeCompare(b.todo.ref)
  );
}

/**
 * 착수 후보를 랭킹해 상위 `limit` 개를 돌려준다.
 *
 * 후보에서 빠지는 것 셋:
 * 1. done / 보관됨 — 할 일이 아니다.
 * 2. `doingState: 'live'` — 살아 있는 세션이 지금 붙들고 있다.
 * 3. **열린 자식을 가진 부모** — 우산 항목이다. 실제 착수 대상은 그 자식이라, 부모를
 *    골라도 무엇을 할지가 안 나온다. 자식이 전부 done 인 부모는 남는다(마무리가 남았다).
 */
export function rankNext(todos: readonly TodoView[], options: RankNextOptions): NextCandidate[] {
  const umbrellas = new Set(
    todos.filter((todo) => todo.parentId && isOpen(todo)).map((todo) => todo.parentId as string),
  );
  const candidates = todos
    .filter((todo) => isOpen(todo) && !umbrellas.has(todo.id) && todo.doingState !== 'live')
    .map((todo) => {
      const { score, labels } = scoreOf(todo, options.now);
      return { todo, score, reason: labels.length > 0 ? labels.join(' · ') : '대기 중' };
    })
    .sort(compareCandidates);
  return options.limit === undefined ? candidates : candidates.slice(0, options.limit);
}

/**
 * 후보 목록을 컴팩트하게 렌더한다 — 한 줄에 `번호. ref  제목  — 근거`.
 *
 * 맨숫자가 아니라 완전 참조(`rocky-12`)를 찍는다. 이 목록은 보드를 넘나들 수 있고(`--all`),
 * 사용자가 다음에 하는 일이 그 참조를 그대로 다른 명령에 붙여넣는 것이다.
 */
export function formatNextCandidates(candidates: readonly NextCandidate[]): string {
  if (candidates.length === 0) {
    return '착수할 후보가 없다 — 열린 항목이 없거나, 남은 것이 전부 다른 세션에 잡혀 있다';
  }
  return candidates
    .map((c, i) => `${i + 1}. ${c.todo.ref}  ${c.todo.title}  — ${c.reason}`)
    .join('\n');
}
