import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { boardKeyFrom, detectActor } from './actor';
import { buildContext, type CliContext, ensureDaemon, health, request } from './client';
import { resolveTodoRuntimeConfig } from './config';
import { installLaunchd, launchdStatus, uninstallLaunchd } from './launchd';
import { loadTodoConfig } from './rocky-config';
import type { NoteView, TodoView } from './server';
import type { Board, HistoryEntry, Section } from './store';
import { tailscaleServeOff, tailscaleServeOn, tailscaleServeStatus } from './tailscale';
import { linkLabel } from './ui/lib';

/**
 * rocky-todo CLI — 데몬의 얇은 HTTP 클라이언트 (보조 표면).
 *
 * 에이전트의 주 경로는 데몬의 `/mcp` 지만, CLI 는 사람/스크립트/데몬 관리용으로
 * 전체 동작을 커버한다. 데몬이 죽어 있으면 자동으로 detached spawn 후 재시도한다.
 * 출력은 컴팩트 텍스트 한 줄주의 — `--json` 으로 원본 JSON.
 */

// ── 인자 파싱 (순수) ─────────────────────────────────────────────────────────

const BOOLEAN_FLAGS = new Set(['all', 'archived', 'json', 'global', 'help']);
const VALUE_FLAGS = new Set([
  'board',
  'section',
  'parent',
  'desc',
  'due',
  'priority',
  'actor',
  'title',
  'content',
  'limit',
]);
const LIST_FLAGS = new Set(['label', 'link']);

export interface ParsedFlags {
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

export function parseFlags(argv: string[]): ParsedFlags {
  const positionals: string[] = [];
  const flags: ParsedFlags['flags'] = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    if (VALUE_FLAGS.has(name) || LIST_FLAGS.has(name)) {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error(`flag --${name} requires a value`);
      }
      if (LIST_FLAGS.has(name)) {
        const list = (flags[name] as string[] | undefined) ?? [];
        if (name === 'label') {
          list.push(
            ...value
              .split(',')
              .map((v) => v.trim())
              .filter((v) => v !== ''),
          );
        } else {
          list.push(value);
        }
        flags[name] = list;
        continue;
      }
      flags[name] = value;
      continue;
    }
    throw new Error(`unknown flag: --${name}`);
  }
  return { positionals, flags };
}

// ── 출력 포맷 (순수) ─────────────────────────────────────────────────────────

const STATUS_GLYPH: Record<TodoView['status'], string> = { todo: '○', doing: '▶', done: '✓' };

/** `○ #12  제목 p1 [label] ~due ↗link (doingBy 12분)` 한 줄. depth 는 2칸 들여쓰기. */
export function formatTodoLine(todo: TodoView, depth: number): string {
  const parts: string[] = [
    STATUS_GLYPH[todo.status],
    `#${String(todo.number).padEnd(3)}`,
    todo.title,
  ];
  if (todo.priority !== 'p4') {
    parts.push(todo.priority);
  }
  for (const label of todo.labels) {
    parts.push(`[${label}]`);
  }
  if (todo.due) {
    parts.push(`~${todo.due}`);
  }
  for (const link of todo.links) {
    parts.push(`↗${link.title ?? linkLabel(link.url)}`);
  }
  if (todo.status === 'doing' && todo.doingBy) {
    const minutes = todo.doingSince
      ? Math.floor((Date.now() - Date.parse(todo.doingSince)) / 60_000)
      : 0;
    parts.push(`(${todo.doingBy} ${minutes}분)`);
  }
  if (todo.archivedAt) {
    parts.push('(보관됨)');
  }
  return `${'  '.repeat(depth)}${parts.join(' ')}`;
}

function renderTree(
  todos: TodoView[],
  out: string[],
  depth: number,
  children: Map<string, TodoView[]>,
): void {
  for (const todo of todos) {
    out.push(formatTodoLine(todo, depth));
    renderTree(children.get(todo.id) ?? [], out, depth + 1, children);
  }
}

function groupAndRender(
  todos: TodoView[],
  sections: Section[],
  boards: Board[],
  allView: boolean,
): string {
  const byId = new Map(todos.map((t) => [t.id, t]));
  const children = new Map<string, TodoView[]>();
  const roots: TodoView[] = [];
  for (const todo of todos) {
    if (todo.parentId && byId.has(todo.parentId)) {
      const list = children.get(todo.parentId) ?? [];
      list.push(todo);
      children.set(todo.parentId, list);
    } else {
      roots.push(todo);
    }
  }
  const out: string[] = [];
  if (allView) {
    for (const board of boards) {
      const items = roots.filter((t) => t.boardId === board.id);
      if (items.length === 0) {
        continue;
      }
      out.push(`# ${board.key}`);
      renderTree(items, out, 1, children);
    }
  } else {
    const noSection = roots.filter((t) => !t.sectionId);
    renderTree(noSection, out, 0, children);
    for (const section of sections) {
      const items = roots.filter((t) => t.sectionId === section.id);
      if (items.length === 0) {
        continue;
      }
      out.push(`# ${section.title}`);
      renderTree(items, out, 1, children);
    }
  }
  return out.length > 0 ? out.join('\n') : '(비어 있음)';
}

// ── HTTP 클라이언트 + 데몬 ensure ────────────────────────────────────────────
// CliContext / health / ensureDaemon / request 는 ./client 로 추출되어
// stdio MCP 브릿지와 공유한다 (순수 리팩터).

/** 활성 노출 채널 기준으로 접속 가능한 주소를 전부 출력한다 — open / daemon status 공용. */
function printAddresses(ctx: CliContext, expose: readonly string[]): void {
  console.log(ctx.baseUrl);
  if (expose.includes('lan')) {
    const nets = Object.values(networkInterfaces()).flat();
    for (const net of nets) {
      if (net && net.family === 'IPv4' && !net.internal) {
        console.log(`http://${net.address}:${ctx.port}  (내부망 — 같은 네트워크 기기용)`);
      }
    }
  }
  if (expose.includes('tailscale-serve')) {
    const proc = Bun.spawnSync({
      cmd: ['tailscale', 'status', '--json'],
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: 3000,
    });
    if (proc.exitCode === 0) {
      try {
        const dns = (JSON.parse(proc.stdout.toString()) as { Self?: { DNSName?: string } }).Self
          ?.DNSName;
        if (dns) {
          console.log(`https://${dns.replace(/\.$/, '')}  (테일넷 기기용)`);
        }
      } catch {
        // status 파싱 실패는 무시 — 주소 안내가 목적일 뿐
      }
    }
  }
}

// ── 보드 키 유추 ─────────────────────────────────────────────────────────────

function git(args: string[]): string | undefined {
  const proc = Bun.spawnSync({ cmd: ['git', ...args], stdout: 'pipe', stderr: 'ignore' });
  if (proc.exitCode !== 0) {
    return undefined;
  }
  const out = proc.stdout.toString().trim();
  return out === '' ? undefined : out;
}

function inferBoardKey(): string {
  return boardKeyFrom({
    remoteUrl: git(['remote', 'get-url', 'origin']),
    toplevel: git(['rev-parse', '--show-toplevel']),
    cwd: process.cwd(),
  });
}

// ── 커맨드 ───────────────────────────────────────────────────────────────────

const HELP = `rocky-todo — 공유 todo/스크래치패드 보드 (데몬 + 웹 UI + MCP 의 CLI 표면)

사용:
  rocky-todo ls [--board K|--all] [--archived] [--json]
  rocky-todo add "제목" [--board K] [--section S] [--parent REF] [--desc MD]
                       [--due YYYY-MM-DD] [--priority p1..p4] [--label a,b] [--link URL]
  rocky-todo show REF · update REF [플래그] [--title "새 제목"]
  rocky-todo start|stop|done|reopen|archive|unarchive REF
  rocky-todo section add "이름" [--board K] · section ls [--board K]
  rocky-todo note add "제목" [--board K|--global] [--content MD]
  rocky-todo note ls [--board K|--global]
  rocky-todo note show REF [--global] | edit REF --content MD [--global] |
                       append REF "텍스트" [--global] | archive REF [--global]
  rocky-todo history REF [--limit N] [--global] · board ls · board add KEY [제목]
  rocky-todo open                              접속 주소 출력 (로컬/내부망/테일넷 — 링크 클릭으로 열기)
  rocky-todo daemon run|start|stop|status|install|uninstall
  rocky-todo mcp setup                         호스트별 MCP 등록 안내
  rocky-todo tailscale on|off|status           테일넷 한정 HTTPS 노출 (옵션, 기본 off)

REF 는 #12 / 12 (현재 보드) 또는 rocky#12 (보드 지정) 또는 raw id 를 받는다.
보드 키는 생략 시 cwd 의 git repo 이름으로 유추한다. actor 는 --actor >
ROCKY_TODO_ACTOR > 호스트 자동 감지. 삭제는 없다 — 아카이브만 존재한다.
note show/edit/append/archive 의 맨 번호(#12/12)는 기본적으로 todos 와 동일하게 현재 보드
컨텍스트로 풀린다 — 전역 메모(웹 UI 의 #3 처럼 보드 접두어 없는 표기)를 번호로 가리키려면
--global 을 반드시 붙인다. 안 붙이면 같은 번호의 보드 메모가 대신 잡힐 수 있다(모호성 회피).
주의: bash 에서 #12 는 주석 시작 문자다 — 따옴표로 감싸서 넘긴다:
  rocky-todo show '#12'   또는  rocky-todo show 12`;

/**
 * ref 로 단건 조회/수정하는 엔드포인트에 `?board=` 를 붙인다. 스토어의 참조 문법은
 * `rocky#12`/raw id/id prefix 는 board 없이도 유일하게 풀리지만, 맨 번호(`#12`/`12`)는
 * 현재 보드 컨텍스트가 없으면 todos 는 에러, notes 는 전역 메모로 풀린다 — CLI 가 유추한
 * board 를 실어 보내지 않으면 `rocky-todo show 12` 같은 흔한 입력이 조용히 실패한다.
 *
 * note show/edit/append/archive 는 이 함수를 무조건 거치지 않는다 — `--global` 이 서 있으면
 * board 를 안 실어서 맨 번호가 전역 메모 공간으로 풀리게 한다(`noteRefPath` 참고). 여기서
 * 무조건 board 를 붙이면, 웹 UI 가 `#3` 으로 보여주는 전역 메모를 그대로 CLI 에 넘겼을 때
 * 같은 번호의 보드 메모가 대신 잡혀 엉뚱한 행을 조용히 archive/edit 하게 된다.
 */
export function withBoard(path: string, board: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}board=${encodeURIComponent(board)}`;
}

/**
 * note 단건 조회/수정 엔드포인트 경로를 만든다. `--global` 이면 board 컨텍스트를 보내지 않아
 * 맨 번호(`#N`)가 전역 메모 공간(`board_id IS NULL`)으로 풀리고, 아니면 todos 와 동일하게
 * 현재 보드로 스코프된다. 기본을 board-스코프로 유지하는 이유: `note add`/`note ls` 가 이미
 * "기본은 보드, --global 로 명시적 opt-in" 패턴이라 note 서브커맨드 전체가 일관되고, 사용자가
 * 플래그 하나 없이도 늘 예측 가능한 대상에 쓴다 (없는 게 위험한 암묵적 동작을 만들지 않는다).
 */
export function noteRefPath(id: string, suffix: string, board: string, global: boolean): string {
  // ref 는 `#`(URL 조각 구분자) 를 담을 수 있어 encode 하지 않으면 브라우저/fetch 가
  // ref 뒷부분과 뒤에 붙는 ?board= 쿼리를 통째로 잘라 버린다 — suffix(`/archive` 등)는
  // 고정 리터럴이라 인코딩 대상이 아니다.
  const path = `/api/notes/${encodeURIComponent(id)}${suffix}`;
  return global ? path : withBoard(path, board);
}

function str(flag: string | boolean | string[] | undefined): string | undefined {
  return typeof flag === 'string' ? flag : undefined;
}

function list(flag: string | boolean | string[] | undefined): string[] | undefined {
  return Array.isArray(flag) ? flag : undefined;
}

export async function runCli(): Promise<void> {
  const { positionals, flags } = parseFlags(process.argv.slice(2));
  const [command, ...rest] = positionals;

  const { todo } = loadTodoConfig();
  const runtime = resolveTodoRuntimeConfig(process.env, todo);
  const ctx = buildContext({
    port: runtime.port,
    dir: runtime.dir,
    actor: str(flags.actor) ?? detectActor(),
  });

  const emitJson = flags.json === true;
  const board = str(flags.board) ?? inferBoardKey();

  const print = (value: unknown, text: () => string) => {
    console.log(emitJson ? JSON.stringify(value, null, 2) : text());
  };

  switch (command) {
    case undefined:
    case 'help': {
      console.log(HELP);
      return;
    }

    case 'ls': {
      const allView = flags.all === true && str(flags.board) === undefined;
      const params = new URLSearchParams();
      if (!allView) {
        params.set('board', board);
      }
      if (flags.archived === true) {
        params.set('includeArchived', 'true');
      }
      const qs = params.size > 0 ? `?${params.toString()}` : '';
      const todos = await request<TodoView[]>(ctx, 'GET', `/api/todos${qs}`);
      const boards = await request<Board[]>(ctx, 'GET', '/api/boards');
      const sections = allView
        ? []
        : await request<Section[]>(ctx, 'GET', `/api/sections?board=${encodeURIComponent(board)}`);
      print(todos, () => groupAndRender(todos, sections, boards, allView));
      return;
    }

    case 'add': {
      const title = rest[0];
      if (!title) {
        throw new Error('usage: rocky-todo add "제목" [플래그]');
      }
      const todo = await request<TodoView>(ctx, 'POST', '/api/todos', {
        board,
        title,
        description: str(flags.desc),
        section: str(flags.section),
        parentId: str(flags.parent),
        priority: str(flags.priority),
        due: str(flags.due),
        labels: list(flags.label),
        links: list(flags.link)?.map((url) => ({ url })),
      });
      print(todo, () => `✓ ${todo.ref} 생성 (${board})`);
      return;
    }

    case 'show': {
      const id = rest[0];
      if (!id) {
        throw new Error('usage: rocky-todo show REF');
      }
      const detail = await request<{ todo: TodoView; history: HistoryEntry[] }>(
        ctx,
        'GET',
        withBoard(`/api/todos/${encodeURIComponent(id)}`, board),
      );
      print(detail, () => {
        const t = detail.todo;
        const lines = [t.ref, formatTodoLine(t, 0)];
        if (t.description !== '') {
          lines.push('', t.description);
        }
        if (t.links.length > 0) {
          lines.push('', ...t.links.map((l) => `↗ ${l.url}`));
        }
        lines.push('', `id: ${t.id}`, '', '히스토리:');
        for (const h of detail.history.slice(0, 8)) {
          lines.push(`  ${h.at.slice(0, 16)} ${h.actor} ${h.action}`);
        }
        return lines.join('\n');
      });
      return;
    }

    case 'update': {
      const id = rest[0];
      if (!id) {
        throw new Error('usage: rocky-todo update REF [플래그]');
      }
      const todo = await request<TodoView>(
        ctx,
        'PATCH',
        withBoard(`/api/todos/${encodeURIComponent(id)}`, board),
        {
          title: str(flags.title),
          description: str(flags.desc),
          section: str(flags.section),
          parentId: str(flags.parent),
          priority: str(flags.priority),
          due: str(flags.due),
          labels: list(flags.label),
          links: list(flags.link)?.map((url) => ({ url })),
        },
      );
      print(todo, () => `✓ ${todo.ref} 수정`);
      return;
    }

    case 'start':
    case 'stop':
    case 'done':
    case 'reopen':
    case 'archive':
    case 'unarchive': {
      const id = rest[0];
      if (!id) {
        throw new Error(`usage: rocky-todo ${command} REF`);
      }
      const todo = await request<TodoView>(
        ctx,
        'POST',
        withBoard(`/api/todos/${encodeURIComponent(id)}/status`, board),
        { action: command },
      );
      print(todo, () => `✓ ${todo.ref} ${command}`);
      return;
    }

    case 'section': {
      const sub = rest[0];
      if (sub === 'add' && rest[1]) {
        // 섹션은 todo_write 경로처럼 upsert — 빈 섹션 생성을 위해 보드만 보장
        await request<Board>(ctx, 'POST', '/api/boards', { key: board });
        const sections = await request<Section[]>(
          ctx,
          'GET',
          `/api/sections?board=${encodeURIComponent(board)}`,
        );
        if (sections.some((s) => s.title === rest[1])) {
          console.log(`✓ 섹션 이미 있음: ${rest[1]}`);
          return;
        }
        // 섹션 단독 생성 API 는 없다 — 자리표시 todo 없이 만들려면 todo 추가 시 --section 사용 안내
        console.log(`섹션은 todo 추가 시 생성된다: rocky-todo add "..." --section "${rest[1]}"`);
        return;
      }
      if (sub === 'ls') {
        const sections = await request<Section[]>(
          ctx,
          'GET',
          `/api/sections?board=${encodeURIComponent(board)}`,
        );
        print(sections, () => sections.map((s) => `# ${s.title}`).join('\n') || '(섹션 없음)');
        return;
      }
      throw new Error('usage: rocky-todo section add "이름" | section ls');
    }

    case 'note': {
      await handleNote(ctx, rest, flags, board, emitJson);
      return;
    }

    case 'history': {
      const id = rest[0];
      if (!id) {
        throw new Error('usage: rocky-todo history REF [--limit N] [--global]');
      }
      const limit = str(flags.limit) ?? '20';
      // prefix 로 들어와도 detail 조회로 전체 id 를 확정한 뒤 히스토리를 가져온다
      const detail: { todo?: TodoView; note?: NoteView } = await request<{
        todo?: TodoView;
        note?: NoteView;
      }>(ctx, 'GET', withBoard(`/api/todos/${encodeURIComponent(id)}`, board)).catch(() =>
        request<{ todo?: TodoView; note?: NoteView }>(
          ctx,
          'GET',
          noteRefPath(id, '', board, flags.global === true),
        ),
      );
      const entityId = detail.todo?.id ?? detail.note?.id ?? id;
      const history = await request<HistoryEntry[]>(
        ctx,
        'GET',
        `/api/history?entityId=${encodeURIComponent(entityId)}&limit=${limit}`,
      );
      print(history, () =>
        history
          .map((h) => {
            const changes = h.changes ? ` ${JSON.stringify(h.changes)}` : '';
            return `${h.at.slice(0, 16)} ${h.actor} ${h.action}${changes}`;
          })
          .join('\n'),
      );
      return;
    }

    case 'board': {
      const sub = rest[0];
      if (sub === 'ls' || sub === undefined) {
        const boards = await request<Board[]>(ctx, 'GET', '/api/boards');
        print(boards, () => boards.map((b) => `${b.key}  ${b.title}`).join('\n') || '(보드 없음)');
        return;
      }
      if (sub === 'add' && rest[1]) {
        const created = await request<Board>(ctx, 'POST', '/api/boards', {
          key: rest[1],
          title: rest[2],
        });
        print(created, () => `✓ 보드 ${created.key}`);
        return;
      }
      throw new Error('usage: rocky-todo board ls | board add KEY [제목]');
    }

    case 'open': {
      // 접속 가능한 주소를 전부 출력한다 — 터미널에서 링크를 눌러 연다 (자동 실행 없음)
      await ensureDaemon(ctx);
      printAddresses(ctx, runtime.expose);
      return;
    }

    case 'daemon': {
      await handleDaemon(ctx, rest[0], runtime.expose);
      return;
    }

    case 'mcp': {
      if (rest[0] === 'setup') {
        console.log(mcpSetupGuide(ctx.baseUrl));
        return;
      }
      throw new Error('usage: rocky-todo mcp setup');
    }

    case 'tailscale': {
      // 옵션 기능 — 기본 off. 회사 등 tailscale 금지 환경에서는 이 커맨드를 쓰지 않으면
      // rocky-todo 는 tailscale 을 일절 건드리지 않는다.
      switch (rest[0]) {
        case 'on':
          console.log(tailscaleServeOn(ctx.port));
          return;
        case 'off':
          console.log(tailscaleServeOff());
          return;
        case 'status':
        case undefined:
          console.log(tailscaleServeStatus());
          return;
        default:
          throw new Error('usage: rocky-todo tailscale on|off|status');
      }
    }

    default:
      throw new Error(`unknown command: ${command}\n\n${HELP}`);
  }
}

async function handleNote(
  ctx: CliContext,
  rest: string[],
  flags: ParsedFlags['flags'],
  board: string,
  emitJson: boolean,
): Promise<void> {
  const sub = rest[0];
  const print = (value: unknown, text: () => string) => {
    console.log(emitJson ? JSON.stringify(value, null, 2) : text());
  };

  switch (sub) {
    case 'add': {
      const title = rest[1];
      if (!title) {
        throw new Error('usage: rocky-todo note add "제목" [--content MD] [--global]');
      }
      const note = await request<NoteView>(ctx, 'POST', '/api/notes', {
        board: flags.global === true ? undefined : board,
        title,
        content: str(flags.content),
      });
      print(note, () => `✓ 메모 ${note.ref}`);
      return;
    }
    case 'ls': {
      const params = new URLSearchParams();
      if (flags.global === true) {
        params.set('global', 'true');
      } else if (flags.all !== true) {
        params.set('board', board);
      }
      if (flags.archived === true) {
        params.set('includeArchived', 'true');
      }
      const qs = params.size > 0 ? `?${params.toString()}` : '';
      const notes = await request<NoteView[]>(ctx, 'GET', `/api/notes${qs}`);
      print(
        notes,
        () =>
          notes.map((n) => `▤ ${n.ref}  ${n.title}${n.archivedAt ? ' (보관됨)' : ''}`).join('\n') ||
          '(메모 없음)',
      );
      return;
    }
    case 'show': {
      const id = rest[1];
      if (!id) {
        throw new Error('usage: rocky-todo note show REF [--global]');
      }
      const detail = await request<{ note: NoteView }>(
        ctx,
        'GET',
        noteRefPath(id, '', board, flags.global === true),
      );
      print(
        detail,
        () =>
          `▤ ${detail.note.ref}  ${detail.note.title}\n\n${detail.note.content}\n\nid: ${detail.note.id}`,
      );
      return;
    }
    case 'edit': {
      const id = rest[1];
      const content = str(flags.content);
      if (!id || content === undefined) {
        throw new Error('usage: rocky-todo note edit REF --content MD [--title 제목] [--global]');
      }
      const note = await request<NoteView>(
        ctx,
        'PATCH',
        noteRefPath(id, '', board, flags.global === true),
        {
          title: str(flags.title),
          content,
        },
      );
      print(note, () => `✓ 메모 ${note.ref} 수정`);
      return;
    }
    case 'append': {
      const id = rest[1];
      const text = rest[2];
      if (!id || !text) {
        throw new Error('usage: rocky-todo note append REF "텍스트" [--global]');
      }
      const note = await request<NoteView>(
        ctx,
        'PATCH',
        noteRefPath(id, '', board, flags.global === true),
        {
          content: text,
          mode: 'append',
        },
      );
      print(note, () => `✓ 메모 ${note.ref} append`);
      return;
    }
    case 'archive': {
      const id = rest[1];
      if (!id) {
        throw new Error('usage: rocky-todo note archive REF [--global]');
      }
      const note = await request<NoteView>(
        ctx,
        'POST',
        noteRefPath(id, '/archive', board, flags.global === true),
      );
      print(note, () => `✓ 메모 ${note.ref} 보관`);
      return;
    }
    default:
      throw new Error('usage: rocky-todo note add|ls|show|edit|append|archive');
  }
}

async function handleDaemon(
  ctx: CliContext,
  sub: string | undefined,
  expose: readonly string[],
): Promise<void> {
  switch (sub) {
    case 'run': {
      const { startDaemon } = await import('./daemon');
      await startDaemon();
      return;
    }
    case 'start': {
      await ensureDaemon(ctx);
      console.log(`✓ daemon on ${ctx.baseUrl}`);
      return;
    }
    case 'stop': {
      try {
        const pid = Number(readFileSync(join(ctx.dir, 'daemon.pid'), 'utf8').trim());
        process.kill(pid, 'SIGTERM');
        console.log(`✓ daemon(pid ${pid}) 종료 — launchd install 상태면 곧 재기동된다`);
      } catch {
        console.log('daemon pid 파일 없음 — 이미 꺼져 있거나 포트만 확인해 보자: daemon status');
      }
      return;
    }
    case 'status': {
      const alive = await health(ctx.baseUrl);
      console.log(alive ? `✓ running on ${ctx.baseUrl}` : `✗ not running (port ${ctx.port})`);
      console.log(launchdStatus());
      if (alive) {
        console.log('접속 주소:');
        printAddresses(ctx, expose);
      }
      return;
    }
    case 'install': {
      console.log(installLaunchd());
      return;
    }
    case 'uninstall': {
      console.log(uninstallLaunchd());
      return;
    }
    default:
      throw new Error('usage: rocky-todo daemon run|start|stop|status|install|uninstall');
  }
}

function mcpSetupGuide(baseUrl: string): string {
  return `rocky-todo 데몬의 MCP 엔드포인트: ${baseUrl}/mcp (streamable HTTP)

Claude Code:
  rocky 플러그인이 http 로 자동 등록한다 (plugin.json 의 mcpServers.rocky-todo → ${baseUrl}/mcp).
  데몬이 안 떠 있으면 도구가 안 붙는다 — rocky-todo daemon start 로 켠 뒤 /mcp 패널에서 retry.
  과거 수동 http 등록이 있으면 제거: claude mcp remove rocky-todo

opencode (~/.config/opencode/opencode.json):
  { "mcp": { "rocky-todo": { "type": "remote", "url": "${baseUrl}/mcp" } } }

Codex (~/.codex/config.toml — streamable HTTP 지원 버전):
  [mcp_servers.rocky-todo]
  url = "${baseUrl}/mcp"`;
}

if (import.meta.main) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
