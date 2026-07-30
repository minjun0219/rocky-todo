/**
 * "다음에 뭘 할까" 후보 랭킹 — 순수 함수.
 *
 * 보드를 그대로 들이밀면 고를 수 없다(실사용 보드가 이미 30건대다). **목록을 좁히는 판정**이
 * 먼저 있어야 한다. 그 판정을 출력 포맷·CLI 에서 떼어 둔 이유는 조합이 많아서다 — 상태 ×
 * 마감 × 우선순위 × 계층을 주입 없이 테스트하려면 순수해야 한다(`./doing` 과 같은 이유).
 *
 * 여기서 하지 않는 것: 세션 대조. `doingState` 는 서버가 이미 `GET /api/todos` 응답에
 * 얹어 준다(`./doing` 의 `resolveDoingState`). 이 모듈은 그 판정을 **소비**만 한다.
 */

import type { TodoView } from './refs';

/** 후보 하나 — 랭킹 점수와 사람이 읽는 근거를 얹는다. */
export interface NextCandidate {
  todo: TodoView;
  score: number;
  /** 왜 위로 왔는지 (예: `이어받기(멈춤) · p2`). 목록의 근거 칸에 그대로 쓴다. */
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
 * 한 화면에서 훑고 고를 수 있는 상한이다. 더 넓히려면 `--limit` 을 준다 — 기본값을 올리면
 * 목록이 스크롤을 먹어 "위에서 세 번째" 같은 판단이 되레 느려진다.
 */
export const NEXT_DEFAULT_LIMIT = 8;

/**
 * 랭킹 밴드 — **앞 자리가 뒤 자리를 항상 이긴다.**
 *
 * 범주 점수를 그냥 더하면 문서화한 순서(주인 없는 진행중 → 마감 → 진행중 → 우선순위 →
 * 최근 댓글)가 깨진다. 첫 구현이 그랬다: `gone` 인 p4(100점)가 마감 지난 p1 + 최근 댓글
 * (70+30+12=112점)에게 밀려, 조용히 썩고 있는 작업이 목록 밖으로 밀려났다.
 *
 * 그래서 각 범주를 **자리값이 다른 칸**에 나눠 담는다. 칸마다 0..99 만 쓰므로 하위 범주를
 * 전부 합쳐도 상위 범주의 한 칸을 넘지 못한다 — 합산의 편의를 유지하면서 사전식 순서가
 * 산술로 보장된다.
 */
const BAND = {
  /** 주인 없는 진행중 — 이어받을 것이 있으면 그게 최우선이다. */
  orphan: 100_000_000,
  due: 1_000_000,
  /** 판정할 수 없는 진행중(사람이 잡았거나 세션 대조 불가) — 마감 아래, 우선순위 위. */
  doing: 10_000,
  priority: 100,
  comment: 1,
} as const;

const PRIORITY_SCORE: Record<TodoView['priority'], number> = { p1: 4, p2: 3, p3: 2, p4: 1 };
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

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `YYYY-MM-DD` → 에포크 기준 일수. 자리 파싱이라 파싱 타임존에 흔들리지 않는다.
 *
 * **달력에 없는 날짜는 `NaN`.** `Date.UTC` 는 범위를 벗어난 값을 거부하지 않고 굴린다 —
 * `2026-02-31` 은 3월 3일, `2026-13-01` 은 이듬해 1월 1일이 된다. `due` 는 어디서도
 * 검증되지 않는 자유 문자열(`z.string()` / `typeof === 'string'`)이라 그런 값이 실제로
 * 저장될 수 있고, 그러면 있지도 않은 마감으로 D-day 를 찍는다. 그래서 되돌려 대조한다.
 */
function dayNumber(date: string): number {
  const text = date.slice(0, 10);
  if (!DATE_SHAPE.test(text)) {
    return Number.NaN;
  }
  const [y, m, d] = text.split('-').map(Number) as [number, number, number];
  const utc = Date.UTC(y, m - 1, d);
  const back = new Date(utc);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return Number.NaN;
  }
  return Math.floor(utc / DAY_MS);
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
    return { score: 3 * BAND.due, labels: [`마감 D+${-days}`] };
  }
  if (days === 0) {
    return { score: 2 * BAND.due, labels: ['마감 D-day'] };
  }
  return days <= DUE_SOON_DAYS
    ? { score: BAND.due, labels: [`마감 D-${days}`] }
    : { score: 0, labels: [] };
}

/**
 * 진행중 점수 — **주인 없는 doing 이 가장 위**다.
 *
 * 이 순서가 랭킹의 핵심이다. 새 일을 하나 더 벌이는 것보다 "누군가 시작해 놓고 끊긴 것"
 * 을 잇는 편이 거의 항상 낫다. `live`(세션이 지금 그걸 붙들고 있음)는 후보에서 아예
 * 빠지므로 여기 오지 않는다 — 두 에이전트가 한 항목을 같이 잡는 사고를 막는 자리다.
 *
 * **두 밴드로 갈린다.** 이어받을 것이 확실한 `gone`/`idle` 은 최상위 밴드(`orphan`)로 가고,
 * 판정할 수 없는 doing 은 훨씬 아래(`doing`)에 둔다 — 사람이 방금 잡았을 수도 있는 항목을
 * 마감 지난 일보다 위에 올릴 근거는 없다.
 */
function doingScore(todo: TodoView): Scored {
  if (todo.status !== 'doing') {
    return { score: 0, labels: [] };
  }
  if (todo.doingState === 'gone') {
    return { score: 2 * BAND.orphan, labels: ['이어받기(세션 없음)'] };
  }
  if (todo.doingState === 'idle') {
    return { score: BAND.orphan, labels: ['이어받기(멈춤)'] };
  }
  // 판정 불가(`unknown`) 나 사람이 잡은 doing. 죽었다고 단정할 수 없으니 "이어받기" 라고
  // 부르지 않되, todo 보다는 위에 둔다 — 이미 손댄 일이다.
  return { score: BAND.doing, labels: [todo.doingBy ? `진행중(${todo.doingBy})` : '진행중'] };
}

/** 우선순위 점수. 라벨은 p1/p2 만 — p3/p4 까지 찍으면 근거 줄이 소음이 된다. */
function priorityScore(todo: TodoView): Scored {
  const score = PRIORITY_SCORE[todo.priority] * BAND.priority;
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
  return { score: BAND.comment, labels: ['최근 댓글'] };
}

/**
 * 범주 점수를 합친다. 각 범주가 자기 밴드 칸만 쓰므로 **합산이 곧 사전식 비교**다
 * ({@link BAND} 참고) — 하위 범주가 아무리 쌓여도 상위 범주를 뒤집지 못한다.
 */
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

/** `summary` 로 자를 길이. 항목이 무엇인지 알아볼 만큼만이고 그 이상은 소음이다. */
const SUMMARY_MAX = 160;

/**
 * `--json` 이 내보내는 후보 하나 — **`TodoView` 전체가 아니다.**
 *
 * 이 JSON 이 답하는 질문은 "무엇을 고를까" 하나다. `TodoView` 를 그대로 실으면 `description`
 * 만으로 수 KB 가 붙는데(실측: 후보 8건 10.8KB, 그중 description 3.2KB) 고르는 데 필요한 건
 * 그게 아니다. 전문이 필요한 쪽은 `show REF` 를 부른다.
 *
 * `/rocky-todo:next` 커맨드는 이걸 쓰지 않는다 — 사람에게 보여줄 목록이 필요하니 텍스트
 * 출력을 그대로 옮긴다. 이 형태는 스크립트와 Claude Code 아닌 호스트(CLI 를 직접 부르는
 * Codex/opencode)를 위한 것이다.
 */
export interface NextCandidateJson {
  ref: string;
  number: number;
  board: string;
  title: string;
  /** {@link NextCandidate.reason} 그대로 — 커맨드는 이 문구를 재작성하지 않는다. */
  reason: string;
  priority: TodoView['priority'];
  status: TodoView['status'];
  due?: string;
  labels: string[];
  commentCount: number;
  /** `description` 을 한 줄로 눌러 {@link SUMMARY_MAX} 자까지. 없으면 필드 자체가 없다. */
  summary?: string;
}

/** 여러 줄 markdown 을 한 줄로 눌러 `max` 자까지 자른다. 자르면 `…` 를 붙인다. */
function condense(text: string, max: number): string | undefined {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') {
    return undefined;
  }
  return flat.length <= max ? flat : `${flat.slice(0, max).trimEnd()}…`;
}

/**
 * 후보를 `--json` 출력용 컴팩트 형태로 옮긴다.
 *
 * @param boardKeyOf boardId → board key. 못 찾으면 빈 문자열 — 여기서 던지지 않는다
 *   (보드 하나를 못 읽는 것 때문에 "다음 작업" 전체가 죽으면 안 된다).
 */
export function toJsonCandidates(
  candidates: readonly NextCandidate[],
  boardKeyOf: (boardId: string) => string | undefined,
): NextCandidateJson[] {
  return candidates.map(({ todo, reason }) => ({
    ref: todo.ref,
    number: todo.number,
    board: boardKeyOf(todo.boardId) ?? '',
    title: todo.title,
    reason,
    priority: todo.priority,
    status: todo.status,
    due: todo.due,
    labels: todo.labels,
    commentCount: todo.commentCount,
    summary: condense(todo.description, SUMMARY_MAX),
  }));
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
