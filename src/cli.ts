import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../core/rocky-config';
import { boardKeyFrom, detectActor } from './actor';
import { DEFAULT_TODO_DIR, resolveTodoRuntimeConfig } from './config';
import { installLaunchd, launchdStatus, uninstallLaunchd } from './launchd';
import type { Board, HistoryEntry, Note, Section, Todo } from './store';
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

const STATUS_GLYPH: Record<Todo['status'], string> = { todo: '○', doing: '▶', done: '✓' };

/** `○ a1b2c3 제목 p1 [label] ~due ↗link (doingBy 12분)` 한 줄. depth 는 2칸 들여쓰기. */
export function formatTodoLine(todo: Todo, depth: number): string {
  const parts: string[] = [STATUS_GLYPH[todo.status], todo.id.slice(0, 6), todo.title];
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
  todos: Todo[],
  out: string[],
  depth: number,
  children: Map<string, Todo[]>,
): void {
  for (const todo of todos) {
    out.push(formatTodoLine(todo, depth));
    renderTree(children.get(todo.id) ?? [], out, depth + 1, children);
  }
}

function groupAndRender(
  todos: Todo[],
  sections: Section[],
  boards: Board[],
  allView: boolean,
): string {
  const byId = new Map(todos.map((t) => [t.id, t]));
  const children = new Map<string, Todo[]>();
  const roots: Todo[] = [];
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

interface CliContext {
  baseUrl: string;
  port: number;
  dir: string;
  actor: string;
}

async function health(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(700) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 데몬이 안 떠 있으면 detached spawn 하고 health 가 응답할 때까지 (최대 ~5s) 기다린다. */
async function ensureDaemon(ctx: CliContext): Promise<void> {
  if (await health(ctx.baseUrl)) {
    return;
  }
  const daemonPath = join(import.meta.dir, 'daemon.ts');
  Bun.spawn({
    cmd: [process.execPath, 'run', daemonPath],
    stdio: ['ignore', 'ignore', 'ignore'],
    env: process.env,
  }).unref();
  for (let i = 0; i < 25; i++) {
    await Bun.sleep(200);
    if (await health(ctx.baseUrl)) {
      return;
    }
  }
  throw new Error(
    `rocky-todo daemon did not start on port ${ctx.port} — check \`rocky-todo daemon status\``,
  );
}

async function request<T>(
  ctx: CliContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  await ensureDaemon(ctx);
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      'x-rocky-actor': ctx.actor,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const payload = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(payload.error ?? `${res.status} ${res.statusText}`);
  }
  return payload;
}

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
  rocky-todo add "제목" [--board K] [--section S] [--parent ID] [--desc MD]
                       [--due YYYY-MM-DD] [--priority p1..p4] [--label a,b] [--link URL]
  rocky-todo show ID · update ID [플래그] [--title "새 제목"]
  rocky-todo start|stop|done|reopen|archive|unarchive ID
  rocky-todo section add "이름" [--board K] · section ls [--board K]
  rocky-todo note add "제목" [--board K|--global] [--content MD]
  rocky-todo note ls|show ID|edit ID --content MD|append ID "텍스트"|archive ID
  rocky-todo history ID [--limit N] · board ls · board add KEY [제목]
  rocky-todo open                              접속 주소 출력 (로컬/내부망/테일넷 — 링크 클릭으로 열기)
  rocky-todo daemon run|start|stop|status|install|uninstall
  rocky-todo mcp setup                         호스트별 MCP 등록 안내
  rocky-todo tailscale on|off|status           테일넷 한정 HTTPS 노출 (옵션, 기본 off)

보드 키는 생략 시 cwd 의 git repo 이름으로 유추한다. actor 는 --actor >
ROCKY_TODO_ACTOR > 호스트 자동 감지. 삭제는 없다 — 아카이브만 존재한다.`;

function str(flag: string | boolean | string[] | undefined): string | undefined {
  return typeof flag === 'string' ? flag : undefined;
}

function list(flag: string | boolean | string[] | undefined): string[] | undefined {
  return Array.isArray(flag) ? flag : undefined;
}

export async function runCli(): Promise<void> {
  const { positionals, flags } = parseFlags(process.argv.slice(2));
  const [command, ...rest] = positionals;

  const { config } = await loadConfig({ projectRoot: DEFAULT_TODO_DIR });
  const runtime = resolveTodoRuntimeConfig(process.env, config.todo);
  const ctx: CliContext = {
    baseUrl: `http://127.0.0.1:${runtime.port}`,
    port: runtime.port,
    dir: runtime.dir,
    actor: str(flags.actor) ?? detectActor(),
  };

  // 마스터 스위치 (todo.enabled, 기본 off) — 데몬을 띄우는 기능이라 opt-in.
  // 안내성 커맨드(help / mcp setup)는 비활성 상태에서도 동작한다.
  const INFO_COMMANDS = new Set([undefined, 'help', 'mcp']);
  if (!runtime.enabled && !INFO_COMMANDS.has(command)) {
    throw new Error(
      'rocky-todo 는 기본 비활성이다 — user rocky.json 에 "todo": { "enabled": true } 를 설정하거나 ROCKY_TODO_ENABLED=1 로 켠다.',
    );
  }

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
      const todos = await request<Todo[]>(ctx, 'GET', `/api/todos${qs}`);
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
      const todo = await request<Todo>(ctx, 'POST', '/api/todos', {
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
      print(todo, () => `✓ ${todo.id.slice(0, 6)} 생성 (${board})`);
      return;
    }

    case 'show': {
      const id = rest[0];
      if (!id) {
        throw new Error('usage: rocky-todo show ID');
      }
      const detail = await request<{ todo: Todo; history: HistoryEntry[] }>(
        ctx,
        'GET',
        `/api/todos/${id}`,
      );
      print(detail, () => {
        const t = detail.todo;
        const lines = [formatTodoLine(t, 0)];
        if (t.description !== '') {
          lines.push('', t.description);
        }
        if (t.links.length > 0) {
          lines.push('', ...t.links.map((l) => `↗ ${l.url}`));
        }
        lines.push('', '히스토리:');
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
        throw new Error('usage: rocky-todo update ID [플래그]');
      }
      const todo = await request<Todo>(ctx, 'PATCH', `/api/todos/${id}`, {
        title: str(flags.title),
        description: str(flags.desc),
        section: str(flags.section),
        parentId: str(flags.parent),
        priority: str(flags.priority),
        due: str(flags.due),
        labels: list(flags.label),
        links: list(flags.link)?.map((url) => ({ url })),
      });
      print(todo, () => `✓ ${todo.id.slice(0, 6)} 수정`);
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
        throw new Error(`usage: rocky-todo ${command} ID`);
      }
      const todo = await request<Todo>(ctx, 'POST', `/api/todos/${id}/status`, { action: command });
      print(todo, () => `✓ ${todo.id.slice(0, 6)} ${command}`);
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
        throw new Error('usage: rocky-todo history ID [--limit N]');
      }
      const limit = str(flags.limit) ?? '20';
      // prefix 로 들어와도 detail 조회로 전체 id 를 확정한 뒤 히스토리를 가져온다
      const detail: { todo?: Todo; note?: Note } = await request<{ todo?: Todo; note?: Note }>(
        ctx,
        'GET',
        `/api/todos/${id}`,
      ).catch(() => request<{ todo?: Todo; note?: Note }>(ctx, 'GET', `/api/notes/${id}`));
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
      const note = await request<Note>(ctx, 'POST', '/api/notes', {
        board: flags.global === true ? undefined : board,
        title,
        content: str(flags.content),
      });
      print(note, () => `✓ 메모 ${note.id.slice(0, 6)}`);
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
      const notes = await request<Note[]>(ctx, 'GET', `/api/notes${qs}`);
      print(
        notes,
        () =>
          notes
            .map((n) => `▤ ${n.id.slice(0, 6)} ${n.title}${n.archivedAt ? ' (보관됨)' : ''}`)
            .join('\n') || '(메모 없음)',
      );
      return;
    }
    case 'show': {
      const id = rest[1];
      if (!id) {
        throw new Error('usage: rocky-todo note show ID');
      }
      const detail = await request<{ note: Note }>(ctx, 'GET', `/api/notes/${id}`);
      print(detail, () => `▤ ${detail.note.title}\n\n${detail.note.content}`);
      return;
    }
    case 'edit': {
      const id = rest[1];
      const content = str(flags.content);
      if (!id || content === undefined) {
        throw new Error('usage: rocky-todo note edit ID --content MD [--title 제목]');
      }
      const note = await request<Note>(ctx, 'PATCH', `/api/notes/${id}`, {
        title: str(flags.title),
        content,
      });
      print(note, () => `✓ 메모 ${note.id.slice(0, 6)} 수정`);
      return;
    }
    case 'append': {
      const id = rest[1];
      const text = rest[2];
      if (!id || !text) {
        throw new Error('usage: rocky-todo note append ID "텍스트"');
      }
      const note = await request<Note>(ctx, 'PATCH', `/api/notes/${id}`, {
        content: text,
        mode: 'append',
      });
      print(note, () => `✓ 메모 ${note.id.slice(0, 6)} append`);
      return;
    }
    case 'archive': {
      const id = rest[1];
      if (!id) {
        throw new Error('usage: rocky-todo note archive ID');
      }
      const note = await request<Note>(ctx, 'POST', `/api/notes/${id}/archive`);
      print(note, () => `✓ 메모 ${note.id.slice(0, 6)} 보관`);
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

Claude Code (user 스코프 — 모든 프로젝트에서 사용):
  claude mcp add --scope user --transport http rocky-todo ${baseUrl}/mcp

opencode (~/.config/opencode/opencode.json):
  { "mcp": { "rocky-todo": { "type": "remote", "url": "${baseUrl}/mcp" } } }

Codex (~/.codex/config.toml — streamable HTTP 지원 버전 필요):
  [mcp_servers.rocky-todo]
  url = "${baseUrl}/mcp"

데몬이 항상 떠 있게 하려면: rocky-todo daemon install (launchd 등록)`;
}

if (import.meta.main) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
