/**
 * UI 순수 헬퍼 — actor 톤(두 대기 컨셉), 시간 표기, 초경량 markdown 렌더 토큰화.
 */
import { isAgentActor } from '../actors';
import type { TodoView } from '../refs';
import type { Comment, HistoryEntry } from '../store';

/**
 * actor → 시각 톤. 에이전트는 warm(앰버), 사람은 cool(아이스 블루).
 * "누가 했나"를 온도로 인코딩하는 것이 이 UI 의 시그니처다.
 */
export function actorTone(actor: string): 'warm' | 'cool' {
  return isAgentActor(actor) ? 'warm' : 'cool';
}

/** doing 경과가 이 시간(ms)을 넘으면 stale 로 표시한다. */
export const STALE_MS = 30 * 60 * 1000;

export function isStale(doingSince: string | undefined, now = Date.now()): boolean {
  if (!doingSince) {
    return false;
  }
  return now - Date.parse(doingSince) > STALE_MS;
}

/** doing 뱃지에 붙일 수식어 — 없으면 null (평범한 "처리중"). */
export interface DoingWarning {
  /** 뱃지에 붙는 짧은 꼬리표. */
  label: string;
  /** 툴팁 — 왜 이렇게 보이는지. */
  title: string;
  /** 심각도. `dead` 는 아무도 안 들고 있다는 뜻이라 더 강하게 표시한다. */
  tone: 'dead' | 'idle' | 'slow';
}

/**
 * doing 하나를 어떻게 경고할지 정한다.
 *
 * 서버가 세션을 실제로 대조한 판정(`doingState`)이 있으면 그걸 우선한다 — 30분 경과
 * 규칙보다 언제나 정확하기 때문이다. 판정이 없거나(`unknown`, 구버전 데몬) 세션은
 * 멀쩡한데(`live`) 오래 걸리는 경우에만 기존 시간 규칙으로 물러난다.
 *
 * `idle` 을 따로 두는 이유: 세션은 살아 있는데 턴이 끝났고 `done` 이 안 온 상태다.
 * 죽은 것(`gone`)과 사람이 취할 행동이 다르다 — 이건 그 세션에 말을 걸면 이어진다.
 */
export function doingWarning(todo: TodoView, now = Date.now()): DoingWarning | null {
  if (todo.doingState === 'gone') {
    return { label: '세션 없음', title: '이 항목을 들고 있던 세션이 사라졌다', tone: 'dead' };
  }
  if (todo.doingState === 'idle') {
    return {
      label: '멈춤',
      title: '세션은 살아 있지만 턴이 끝났고 완료 처리가 없다',
      tone: 'idle',
    };
  }
  if (todo.doingState === 'live') {
    return null;
  }
  return isStale(todo.doingSince, now)
    ? { label: '오래됨', title: '30분 이상 갱신 없음', tone: 'slow' }
    : null;
}

/** "방금" / "N분" / "N시간" / "N일" — doing 뱃지와 히스토리 타임스탬프용. */
export function formatElapsed(iso: string, now = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(iso));
  const min = Math.floor(ms / 60_000);
  if (min < 1) {
    return '방금';
  }
  if (min < 60) {
    return `${min}분`;
  }
  const hours = Math.floor(min / 60);
  if (hours < 24) {
    return `${hours}시간`;
  }
  return `${Math.floor(hours / 24)}일`;
}

/** 마감일 표기 — "8/1" 형태. 지난 날짜 여부는 isOverdue 로 별도 판단. */
export function formatDue(due: string): string {
  const [, month, day] = due.split('-');
  if (!month || !day) {
    return due;
  }
  return `${Number(month)}/${Number(day)}`;
}

export function isOverdue(due: string, now = new Date()): boolean {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return due < today;
}

export type MdToken =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'code'; value: string }
  | { type: 'link'; value: string };

/**
 * 초경량 markdown 토큰화 — **bold** / `code` / http(s) URL 만 지원.
 * React 노드로 조립하므로 HTML escape 는 불필요하다 (innerHTML 미사용).
 */
export function mdTokens(text: string): MdToken[] {
  const tokens: MdToken[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/\S+)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) {
      tokens.push({ type: 'text', value: text.slice(last, index) });
    }
    const raw = match[0];
    if (raw.startsWith('**')) {
      tokens.push({ type: 'bold', value: raw.slice(2, -2) });
    } else if (raw.startsWith('`')) {
      tokens.push({ type: 'code', value: raw.slice(1, -1) });
    } else {
      tokens.push({ type: 'link', value: raw });
    }
    last = index + raw.length;
  }
  if (last < text.length) {
    tokens.push({ type: 'text', value: text.slice(last) });
  }
  return tokens;
}

/** copyRef 가 실제로 건드리는 clipboard 표면 — 테스트에서 fake 로 대체 가능. */
export interface CopyRefClipboard {
  writeText(text: string): Promise<void>;
}

/** copyRef 가 실제로 건드리는 element(textarea)의 최소 표면. */
export interface CopyRefTextArea {
  value: string;
  setAttribute(name: string, value: string): void;
  style: { position: string; opacity: string };
  select(): void;
}

/** copyRef 가 실제로 건드리는 document 표면 — 테스트에서 fake 로 대체 가능. */
export interface CopyRefDocument {
  createElement(tagName: 'textarea'): CopyRefTextArea;
  body: {
    appendChild(node: CopyRefTextArea): void;
    removeChild(node: CopyRefTextArea): void;
  };
  execCommand(command: string): boolean;
}

/** copyRef 가 의존하는 전역 — 기본값은 실제 브라우저 전역, 테스트는 fake 를 주입한다. */
export interface CopyRefEnv {
  clipboard?: CopyRefClipboard;
  document?: CopyRefDocument;
}

/**
 * 실제 브라우저 전역을 가리키는 기본 env — 프로덕션 호출부는 이 값을 그대로 쓴다.
 *
 * 실제 `Document`/`Clipboard` 는 `CopyRefDocument`/`CopyRefClipboard` 보다 훨씬 넓은
 * 표면(제네릭 `appendChild<T extends Node>` 등)을 가져 구조적으로 딱 들어맞지 않는다 —
 * copyRef 가 실제로 쓰는 최소 표면만 뽑아낸 형태이므로 여기서만 단언(assert)한다.
 */
function defaultCopyRefEnv(): CopyRefEnv {
  return {
    clipboard: typeof navigator !== 'undefined' ? navigator.clipboard : undefined,
    document:
      typeof document !== 'undefined' ? (document as unknown as CopyRefDocument) : undefined,
  };
}

/**
 * 참조 문자열을 클립보드에 복사한다.
 *
 * `navigator.clipboard` 는 보안 컨텍스트(HTTPS·루프백)에서만 동작한다 — LAN 평문
 * HTTP(`192.168.x.x:8636`)로 접속하면 없다. 그 경우 execCommand 로 폴백하고,
 * 그마저 실패하면 false 를 돌려줘 호출자가 수동 복사 안내를 띄우게 한다.
 *
 * `env` 는 clipboard/document 접근을 주입하기 위한 선택 인자다 — 생략하면 실제
 * 전역을 쓰므로 프로덕션 호출부(`copyRef(text)`)는 그대로 동작한다. 테스트는
 * fake env 를 넘겨 보안 컨텍스트가 아닌 상황(LAN HTTP)의 execCommand 폴백을
 * DOM 없이 검증한다.
 */
export async function copyRef(
  text: string,
  env: CopyRefEnv = defaultCopyRefEnv(),
): Promise<boolean> {
  if (env.clipboard?.writeText) {
    try {
      await env.clipboard.writeText(text);
      return true;
    } catch {
      // 권한 거부 — 아래 폴백으로 내려간다.
    }
  }
  const doc = env.document;
  if (!doc?.execCommand) {
    return false;
  }
  const area = doc.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  doc.body.appendChild(area);
  area.select();
  try {
    return doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    doc.body.removeChild(area);
  }
}

/** 보드 스킬의 슬래시 커맨드 이름 — 플러그인 `rocky-todo` 의 `skills/board`. */
const BOARD_SKILL_COMMAND = '/rocky-todo:board';

/**
 * 참조를 클립보드에 넣을 슬래시 커맨드로 감싼다 — `rocky-12` → `/rocky-todo:board rocky-12`.
 *
 * 참조만 복사하면 세션에 붙여넣었을 때 에이전트가 "이 문자열로 뭘 하라는 건지" 를 모른다.
 * 커맨드까지 함께 복사하면 붙여넣기 한 번이 곧 "이 항목을 맡아라" 가 된다. 화면에 보이는
 * 글자는 참조 그대로 두고 클립보드 값만 넓히는 것이 요점이다 — 버튼에 커맨드 전문을
 * 그리면 행이 읽히지 않는다.
 */
export function boardCommand(ref: string): string {
  return `${BOARD_SKILL_COMMAND} ${ref}`;
}

/** copyRefWithFeedback 이 복사 성공 후 몇 ms 뒤에 copied 플래그를 지우는지 — 기존
 * TodoItem/NotesRail/DetailDrawer(todo·note) 네 호출부가 각각 하드코딩했던 1200ms 를
 * 여기 하나로 고정한다. */
export const COPY_FEEDBACK_MS = 1200;

/** clipboard 접근 실패 시 안내하는 prompt 문구 — 기존 네 호출부가 복붙하던 문자열. */
const CLIPBOARD_UNAVAILABLE_MESSAGE = '클립보드에 접근할 수 없다 — 아래 텍스트를 직접 복사해라:';

/**
 * `copyRefWithFeedback` 이 의존하는 전역 — {@link CopyRefEnv}(clipboard/document) 에
 * 더해 실패 시 prompt 폴백과 "copied 플래그를 지우는 타이머"까지 주입 가능하게 확장한다.
 * 기본값은 실제 브라우저 전역(`window.prompt`/`window.setTimeout`) — 프로덕션 호출부는
 * `env` 를 생략해도 그대로 동작한다. 테스트는 fake 를 넘겨 1200ms 를 실제로 기다리지
 * 않고 성공/실패 경로를 검증한다 (`copyRef` 와 동일한 주입 패턴 — `src/ui/lib.test.ts`).
 */
export interface CopyRefWithFeedbackEnv extends CopyRefEnv {
  prompt?: (message: string, defaultValue?: string) => string | null;
  setTimeout?: (handler: () => void, ms: number) => unknown;
}

function defaultCopyRefWithFeedbackEnv(): CopyRefWithFeedbackEnv {
  return {
    ...defaultCopyRefEnv(),
    prompt: typeof window !== 'undefined' ? window.prompt.bind(window) : undefined,
    setTimeout: typeof window !== 'undefined' ? window.setTimeout.bind(window) : undefined,
  };
}

/**
 * 참조 문자열을 복사하고 성공/실패에 따라 UI 피드백을 건다.
 *
 * `TodoItem`/`NotesRail`/`DetailDrawer`(todo·note 경로 둘 다) 네 곳이 복붙해 쓰던
 * 시퀀스 — `copyRef` 호출 → 성공하면 `copied` 플래그를 세우고 {@link COPY_FEEDBACK_MS}
 * 뒤 타이머로 해제 → 실패하면 `window.prompt` 로 수동 복사 안내 — 를 한 곳에 모은다.
 * 표면마다 타이머 길이·안내 문구가 따로 놀 여지를 없앤다.
 *
 * 훅이 아니라 순수 함수다 — `onCopied`(대개 컴포넌트의 `setCopied`)를 콜백으로 받아
 * 상태 갱신을 호출부에 위임하므로 React 렌더 사이클 없이 `bun:test` 로 단위
 * 테스트할 수 있다(신규 React 테스트 의존성 불필요). `env` 는 `copyRef` 와 같은 패턴으로
 * clipboard/document/prompt/setTimeout 접근을 주입한다 — 생략하면 실제 전역을 쓴다.
 *
 * title/aria-label 렌더링은 손대지 않는다 — 버튼의 보이는 텍스트(목록 행에서는 맨숫자,
 * 드로어에서는 전체 ref)만으로는 스크린리더가 제대로 안내하지 못한다는 과거 리뷰
 * 지적으로 각 호출부가 이미 명시적
 * `aria-label` 을 달아 두었고, 그건 이 헬퍼가 반환하는 `copied` 상태를 그대로 읽는
 * 호출부(JSX)의 책임으로 남긴다.
 */
export async function copyRefWithFeedback(
  ref: string,
  onCopied: (copied: boolean) => void,
  env: CopyRefWithFeedbackEnv = defaultCopyRefWithFeedbackEnv(),
): Promise<void> {
  const ok = await copyRef(ref, env);
  if (ok) {
    onCopied(true);
    env.setTimeout?.(() => onCopied(false), COPY_FEEDBACK_MS);
    return;
  }
  env.prompt?.(CLIPBOARD_UNAVAILABLE_MESSAGE, ref);
}

/** 링크 URL → 짧은 출처 라벨 (github.com/owner/repo#12, todoist, …). */
export function linkLabel(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === 'github.com') {
      const [owner, repo, kind, num] = u.pathname.slice(1).split('/');
      if (owner && repo && (kind === 'issues' || kind === 'pull') && num) {
        return `${repo}#${num}`;
      }
      return `${owner}/${repo ?? ''}`.replace(/\/$/, '');
    }
    if (u.hostname.includes('todoist')) {
      return 'todoist';
    }
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * 이벤트가 편집 중인 요소에서 왔는지 판정한다.
 *
 * 드로어의 전역 Esc 리스너가 입력 중인 Esc 까지 가로채면, 사용자가 기대한 "입력 취소"
 * 대신 드로어가 통째로 닫히며 편집분이 날아간다. 전역 단축키는 이 판정으로 걸러 낸다.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target) {
    return false;
  }
  const el = target as { tagName?: string; isContentEditable?: boolean };
  const tag = el.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

/** 히스토리 줄과 댓글 카드를 한 줄기로 묶은 타임라인 항목. */
export type TimelineItem =
  | { kind: 'history'; at: string; entry: HistoryEntry }
  | { kind: 'comment'; at: string; comment: Comment };

/**
 * 댓글 계열 히스토리 액션 중 타임라인/상세 화면에서 버리는 것 — 댓글 카드가 여전히
 * 그 사건을 대표하는 두 가지(작성/본문 수정)만 뺀다.
 *
 * 댓글 mutation 은 부모 todo 의 히스토리로도 기록된다(SSE·훅 주입 경로를 타기 위해서다).
 * `comment`/`comment-edit` 을 그대로 두면 같은 사건이 댓글 카드와 히스토리 한 줄로 두 번
 * 보인다. `comment-archive`/`comment-unarchive` 는 빼지 않는다 — 보관되면 카드 자체가
 * 사라지므로(대표하는 화면 요소가 없어짐) 타임라인에 흔적이 남아야 한다.
 *
 * `src/store.ts` 의 `DETAIL_HISTORY_EXCLUDED` 와 같은 값 쌍이다 — 여기서 별도로 export
 * 하는 이유는 이 파일이 브라우저에 번들되는 UI 코드라서다: `store.ts` 를 런타임으로
 * import 하면 `bun:sqlite` 가 클라이언트 번들 그래프에 끌려온다(기존 `import type`
 * 은 타입만 지워지니 안전하지만, 값 import 는 안 된다). 값이 둘로 나뉘어 있는 만큼
 * `src/ui/lib.test.ts` 가 두 목록의 내용이 같은지 회귀 테스트로 고정한다 — 셋째 액션이
 * 생기면 여기와 `src/store.ts` 양쪽을 함께 고쳐야 한다.
 */
export const DETAIL_HISTORY_EXCLUDED: readonly string[] = ['comment', 'comment-edit'];

const COMMENT_HISTORY_ACTIONS: ReadonlySet<string> = new Set(DETAIL_HISTORY_EXCLUDED);

/**
 * 히스토리와 댓글을 시간순(**최신 우선**)으로 병합한다. 드로어의 기존 히스토리 렌더가
 * 최신 우선이라 그 방향을 유지한다.
 */
export function mergeTimeline(history: HistoryEntry[], comments: Comment[]): TimelineItem[] {
  const items: TimelineItem[] = [
    ...history
      .filter((entry) => !COMMENT_HISTORY_ACTIONS.has(entry.action))
      .map((entry) => ({ kind: 'history' as const, at: entry.at, entry })),
    ...comments.map((comment) => ({ kind: 'comment' as const, at: comment.createdAt, comment })),
  ];
  // 동률은 0 을 돌려 안정 정렬을 유지한다 (같은 밀리초의 두 항목이 뒤바뀌지 않게).
  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/**
 * 절대 작성 시각 — 오늘이면 `HH:MM`, 다른 날이면 `MM-DD HH:MM` (브라우저 로컬 타임존).
 * 상대 시각(`formatElapsed`)은 "언제 썼는지"를 정확히 못 알려줘 댓글에는 쓰지 않는다.
 */
export function formatStamp(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return sameDay ? hm : `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${hm}`;
}

/** localStorage 의 최소 계약 — 테스트에서 인메모리 대역을 넣기 위해 좁혀 둔다. */
export interface SeenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const SEEN_KEY = 'rocky-todo-seen-comments';

/**
 * todo id → 마지막으로 확인한 댓글 시각(ISO). 깨진 값은 빈 커서로 취급한다.
 *
 * 값까지 문자열인지 검사해 걸러낸다 — localStorage 는 다른 탭·구버전·수동 편집이
 * 무엇이든 써 넣을 수 있고, 숫자/객체가 섞이면 `hasUnreadComments` 의 문자열 비교가
 * 커서를 엉뚱하게 판정한다. 걸러진 항목은 "본 적 없음"(= 미확인)으로 떨어진다.
 */
export function readSeen(storage: SeenStorage): Record<string, string> {
  try {
    const parsed = JSON.parse(storage.getItem(SEEN_KEY) ?? '{}') as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const seen: Record<string, string> = {};
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === 'string') {
        seen[id] = at;
      }
    }
    return seen;
  } catch {
    return {};
  }
}

/** 이 todo 의 댓글을 `at` 까지 확인했다고 기록한다. */
export function markSeen(storage: SeenStorage, todoId: string, at: string): void {
  const seen = readSeen(storage);
  seen[todoId] = at;
  storage.setItem(SEEN_KEY, JSON.stringify(seen));
}

/** 읽음 커서보다 새로운 댓글이 있는지 — 배지 강조 조건. */
export function hasUnreadComments(
  todo: { id: string; lastCommentAt?: string },
  seen: Record<string, string>,
): boolean {
  if (!todo.lastCommentAt) {
    return false;
  }
  const at = seen[todo.id];
  return at === undefined || at < todo.lastCommentAt;
}

/** 사용자가 고른 테마 의도. `auto` 는 OS 설정을 따른다는 뜻이다. */
export type ThemePref = 'auto' | 'dark' | 'light';

/** 실제로 화면에 적용되는 테마 — `auto` 가 해석된 결과. */
export type ResolvedTheme = 'dark' | 'light';

/** 테마 선호를 담는 localStorage 키. */
export const THEME_KEY = 'rocky-todo:theme';

/**
 * localStorage 에서 읽은 원문을 테마 선호로 해석한다.
 * 알 수 없는 값은 전부 `auto` 다 — 손으로 고쳤거나 옛 버전이 남긴 값이 화면을 깨뜨리면
 * 안 된다.
 */
export function readThemePref(stored: string | null): ThemePref {
  return stored === 'dark' || stored === 'light' || stored === 'auto' ? stored : 'auto';
}

/**
 * 테마 선호와 OS 설정으로부터 실제 적용할 테마를 해석한다.
 *
 * **`src/ui/index.html` 의 인라인 스크립트가 같은 규칙을 손으로 복제하고 있다** — 그쪽은
 * 번들 전에 첫 페인트를 막고 실행돼야 해서 이 모듈을 import 할 수 없다. 한쪽을 고치면
 * 반드시 다른 쪽도 고쳐야 한다. `src/ui/inline-theme.test.ts` 가 그 스크립트를 실제로
 * 실행해 두 경로의 결론이 갈라지는지 감시한다.
 */
export function resolveTheme(pref: ThemePref, prefersLight: boolean): ResolvedTheme {
  if (pref === 'auto') {
    return prefersLight ? 'light' : 'dark';
  }
  return pref;
}

/** 드래그 정렬에서 형제로 인정되는 조건 — 같은 보드·섹션·부모 안에서만 순서를 바꾼다. */
export interface ReorderSibling {
  id: string;
  boardId: string;
  sectionId?: string;
  parentId?: string;
}

/**
 * 드롭 결과를 move API 의 `before` 값으로 바꾼다 (순수 — 단위 테스트 대상).
 *
 * @param siblings 화면 표시 순서의 형제 목록 (드래그 중인 항목 포함)
 * @param dragId   끌고 있는 항목
 * @param overId   포인터가 올라간 항목
 * @param after    포인터가 그 항목의 아래쪽 절반에 있었는가
 * @returns `{ before }` — null 은 맨 끝. **이동이 무의미하면 undefined** (제자리 드롭,
 *   형제가 아닌 대상, 자기 자신).
 */
export function resolveDropBefore(
  siblings: ReorderSibling[],
  dragId: string,
  overId: string,
  after: boolean,
): { before: string | null } | undefined {
  const drag = siblings.find((s) => s.id === dragId);
  const over = siblings.find((s) => s.id === overId);
  if (!drag || !over || dragId === overId) {
    return undefined;
  }
  if (
    drag.boardId !== over.boardId ||
    (drag.sectionId ?? null) !== (over.sectionId ?? null) ||
    (drag.parentId ?? null) !== (over.parentId ?? null)
  ) {
    return undefined; // 섹션·부모를 넘는 이동은 정렬이 아니라 소속 변경이다 — 드로어의 몫
  }
  const order = siblings.map((s) => s.id);
  const overIndex = order.indexOf(overId);
  const beforeId = after ? (order[overIndex + 1] ?? null) : overId;
  if (beforeId === dragId) {
    return undefined; // 결과가 제자리
  }
  // 바로 앞 형제의 "아래"로 놓는 것도 제자리다
  const dragIndex = order.indexOf(dragId);
  if (beforeId === null && dragIndex === order.length - 1) {
    return undefined;
  }
  if (beforeId !== null && order.indexOf(beforeId) === dragIndex + 1) {
    return undefined;
  }
  return { before: beforeId };
}
