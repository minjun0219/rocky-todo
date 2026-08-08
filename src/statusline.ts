/**
 * statusline 한 줄 렌더 — 순수 함수.
 *
 * 보드를 보려고 창을 하나 더 띄우는 대신, 이미 떠 있는 Claude Code statusline 에
 * 세그먼트 하나로 얹는다. 그래서 이 모듈의 기본값은 전부 **조용한 쪽**이다 — 보여줄
 * 게 없으면 빈 문자열이고, 빈 문자열이면 호출부가 아무것도 출력하지 않는다.
 *
 * 렌더를 데몬이 하는 이유는 통합 비용 때문이다. 사람 쪽 statusline 명령은
 * `curl` 한 줄이 되고, 그 자리는 1초마다 × 열어둔 세션 수만큼 도는 곳이라
 * bun 프로세스 기동(~30–50ms)을 없애는 값이 크다.
 */

/** 이 세션이 지금 `doing` 으로 잡고 있는 항목 — 세션 귀속(`doingSessionId`)으로 찾는다. */
export interface StatuslineMine {
  ref: string;
  title: string;
  /** 보관되지 않은 댓글 수. 사람이 댓글을 달면 이 숫자가 올라간다. */
  comments: number;
}

/** 템플릿이 소비하는 재료 전부. 서버 라우트가 채운다. */
export interface StatuslineData {
  mine?: StatuslineMine;
  /** 이 세션 앞으로 대기 중인(pending) 핸드오프 수. */
  inbox: number;
  /** 보드에서 방치된 doing 수 — `resolveDoingState` 가 `idle`/`gone` 인 것. */
  stale: number;
  /** 보드의 전체 doing 수. */
  doing: number;
}

/**
 * 기본 템플릿 — 세션 앵커 중심.
 *
 * "지금 내가 뭐 하기로 했더라" 를 늘 띄워두는 것이 이 기능의 본래 목적이라, 첫 그룹이
 * 이 세션의 항목을 제목까지 싣는다. 나머지는 숫자가 0이면 통째로 사라진다.
 */
export const DEFAULT_STATUSLINE_TEMPLATE =
  '[⏺ {mine.ref} {mine.title}][ 💬{mine.comments}][  ✉{inbox}][  ⚠{stale}]';

/** 제목 절단 길이 — statusline 은 한 줄이라 긴 제목이 다른 세그먼트를 밀어낸다. */
export const STATUSLINE_TITLE_MAX = 30;

/** ANSI 이스케이프의 도입부 — 템플릿의 `[`/`]` 가 리터럴인지 가르는 유일한 신호다. */
const ESC = '\u001b';

const PLACEHOLDER = /\{([a-z][a-z.]*)\}/g;

/** 제목을 한 줄에 맞게 줄인다. 경계에서 자르고 `…` 로 잘렸음을 표시한다. */
export function truncateTitle(title: string, max = STATUSLINE_TITLE_MAX): string {
  const trimmed = title.trim();
  return [...trimmed].length <= max ? trimmed : `${[...trimmed].slice(0, max).join('')}…`;
}

/** 0 은 "없음" 이다 — 빈 문자열이 되어 자기가 속한 그룹을 통째로 지운다. */
function count(n: number): string {
  return n > 0 ? String(n) : '';
}

function valuesOf(data: StatuslineData, titleMax: number): Map<string, string> {
  return new Map([
    ['mine.ref', data.mine?.ref ?? ''],
    ['mine.title', data.mine ? truncateTitle(data.mine.title, titleMax) : ''],
    ['mine.comments', data.mine ? count(data.mine.comments) : ''],
    ['inbox', count(data.inbox)],
    ['stale', count(data.stale)],
    ['doing', count(data.doing)],
  ]);
}

interface Part {
  text: string;
  /** 대괄호 그룹인가 — 안의 알려진 placeholder 가 전부 비면 통째로 사라진다. */
  group: boolean;
}

/**
 * 템플릿을 리터럴 조각과 대괄호 그룹으로 쪼갠다.
 *
 * **ESC 바로 뒤의 `[`/`]` 는 리터럴이다.** ANSI 색상은 `ESC[33m` 꼴이라 이 예외가 없으면
 * 색을 넣은 템플릿이 전부 그룹 문법으로 오독된다. 색을 별도 DSL 로 만들지 않고 템플릿
 * 문자열에 이스케이프를 직접 적게 한 선택(JSON 이라 `\u001b` 가 그대로 들어간다)의
 * 대가이자, 그 대가를 한 줄로 치르는 방법이다.
 *
 * 중첩은 지원하지 않는다. 닫히지 않은 `[` 는 리터럴로 되돌려 조용히 잘려나가지 않게 한다.
 */
function splitGroups(template: string): Part[] {
  const parts: Part[] = [];
  let buf = '';
  let inGroup = false;
  for (let i = 0; i < template.length; i += 1) {
    const ch = template[i] as string;
    const literalBracket = i > 0 && template[i - 1] === ESC;
    if (ch === '[' && !literalBracket && !inGroup) {
      if (buf !== '') {
        parts.push({ text: buf, group: false });
      }
      buf = '';
      inGroup = true;
      continue;
    }
    if (ch === ']' && !literalBracket && inGroup) {
      parts.push({ text: buf, group: true });
      buf = '';
      inGroup = false;
      continue;
    }
    buf += ch;
  }
  if (inGroup) {
    parts.push({ text: `[${buf}`, group: false });
  } else if (buf !== '') {
    parts.push({ text: buf, group: false });
  }
  return parts;
}

/**
 * 조각 하나를 치환한다.
 *
 * 모르는 placeholder 는 **그대로 남긴다** — 조용히 지우면 오타(`{mine.titel}`)가 "값이
 * 없나 보다" 로 보여 영영 안 고쳐진다. 남겨두면 statusline 에 그대로 떠서 즉시 눈에 띈다.
 * 같은 이유로 모르는 이름은 그룹 생존 판정에 참여하지 않는다.
 */
function renderPart(text: string, values: Map<string, string>): { out: string; keep: boolean } {
  let known = 0;
  let filled = 0;
  const out = text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = values.get(name);
    if (value === undefined) {
      return whole;
    }
    known += 1;
    if (value !== '') {
      filled += 1;
    }
    return value;
  });
  return { out, keep: known === 0 || filled > 0 };
}

/**
 * 템플릿에 데이터를 적용해 statusline 한 줄을 만든다.
 *
 * 문법은 둘뿐이다:
 * - `{name}` — 값으로 치환. 없는 값은 빈 문자열, 모르는 이름은 그대로 남는다.
 * - `[...]` — 옵셔널 그룹. 안의 알려진 placeholder 가 **전부** 비었으면 그룹이 통째로
 *   사라진다. placeholder 가 하나도 없는 그룹은 늘 남는다(순수 장식).
 *
 * 결과는 trim 한다 — 그룹이 앞에서부터 사라지면 구분용 공백만 남기 때문이고, 이 값은
 * 독립된 한 줄로 쓰이므로 앞뒤 공백에 의미가 없다.
 *
 * @returns 보여줄 게 없으면 빈 문자열. 호출부는 이걸 "출력하지 않음" 으로 다뤄야 한다.
 */
export function renderStatusline(
  template: string,
  data: StatuslineData,
  titleMax = STATUSLINE_TITLE_MAX,
): string {
  const values = valuesOf(data, titleMax);
  let out = '';
  for (const part of splitGroups(template)) {
    const rendered = renderPart(part.text, values);
    if (!part.group || rendered.keep) {
      out += rendered.out;
    }
  }
  return out.trim();
}

/** {@link boardKeyForCwd} 가 보는 보드 정보 — store 의 `Board` 중 필요한 두 필드. */
export interface BoardLocation {
  key: string;
  path?: string;
}

/**
 * 끝의 `/` 를 떼어 비교 가능한 꼴로 만든다. 루트는 `/` 로 남긴다(빈 문자열이 되면
 * 모든 비교가 무너진다).
 *
 * `boards.path` 는 정규화된 값이 **아니다** — `setBoardPath` 는 `.trim()` 만 하고,
 * 슬래시를 떼는 건 spawn 라우트뿐이라 `PUT /api/boards/:key/path` 로는 `/repo/` 가
 * 그대로 저장된다.
 */
function normalizePath(path: string): string {
  const stripped = path.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

/** `/a/b` 가 `/a/bc` 에 걸리지 않도록 경로 경계까지 본다. */
function isUnder(cwd: string, path: string): boolean {
  const base = normalizePath(path);
  const here = normalizePath(cwd);
  return here === base || here.startsWith(base === '/' ? '/' : `${base}/`);
}

/**
 * cwd 로 보드를 고른다.
 *
 * `basename(cwd)` 는 쓸 수 없다 — 워크트리에서는 그게 `todo-12` 나 `eelpout` 이라
 * 원본 레포의 보드를 놓친다. 그래서 두 단계다: 먼저 `boards.path` 아래인지 보고(가장
 * 정확하다), 아니면 보드 key 가 cwd 의 **경로 세그먼트**로 나타나는지 본다 —
 * 핸드오프 대상 매칭(`matchBoard`)이 쓰는 것과 같은 규약이라 둘이 같은 답을 낸다.
 *
 * 후보가 여럿이면 가장 긴 것을 고른다(더 구체적인 쪽). `matchBoard` 는 이럴 때 사람에게
 * 묻지만 statusline 은 물을 수 없고, 힌트 한 줄에서는 아무것도 안 고르는 것보다 결정적으로
 * 하나를 고르는 편이 낫다.
 */
export function boardKeyForCwd(
  boards: BoardLocation[],
  cwd: string | undefined,
): string | undefined {
  if (!cwd) {
    return undefined;
  }
  // 길이 비교도 정규화한 값으로 한다 — 안 그러면 `/repo/` 가 슬래시 한 칸 때문에
  // `/repo` 보다 "더 구체적" 으로 잡힌다.
  const byPath = boards
    .flatMap((board) => (board.path ? [{ key: board.key, path: normalizePath(board.path) }] : []))
    .filter((board) => isUnder(cwd, board.path))
    .sort((a, b) => b.path.length - a.path.length);
  if (byPath[0]) {
    return byPath[0].key;
  }
  const segments = new Set(cwd.split('/'));
  const bySegment = boards
    .filter((board) => board.key !== '' && segments.has(board.key))
    .sort((a, b) => b.key.length - a.key.length);
  return bySegment[0]?.key;
}
