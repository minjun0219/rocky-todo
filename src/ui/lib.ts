/**
 * UI 순수 헬퍼 — actor 톤(두 대기 컨셉), 시간 표기, 초경량 markdown 렌더 토큰화.
 */

/** 에이전트로 취급하는 actor 이름 — 따뜻한 앰버 톤 (에리디언의 대기). */
const AGENT_ACTORS = new Set(['claude-code', 'codex', 'opencode', 'agent', 'rocky']);

/**
 * actor → 시각 톤. 에이전트는 warm(앰버), 사람은 cool(아이스 블루).
 * "누가 했나"를 온도로 인코딩하는 것이 이 UI 의 시그니처다.
 */
export function actorTone(actor: string): 'warm' | 'cool' {
  return AGENT_ACTORS.has(actor) ? 'warm' : 'cool';
}

/** doing 경과가 이 시간(ms)을 넘으면 stale 로 표시한다. */
export const STALE_MS = 30 * 60 * 1000;

export function isStale(doingSince: string | undefined, now = Date.now()): boolean {
  if (!doingSince) {
    return false;
  }
  return now - Date.parse(doingSince) > STALE_MS;
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
 * title/aria-label 렌더링은 손대지 않는다 — 버튼의 보이는 텍스트(`#12`)만으로는
 * 스크린리더가 제대로 안내하지 못한다는 과거 리뷰 지적으로 각 호출부가 이미 명시적
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
