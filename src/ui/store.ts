import { create } from 'zustand';
import type { NoteView, TodoView } from '../server';
import type { Board, HistoryEntry, Section, StatusAction } from '../store';
import {
  type BoardSelection,
  buildPath,
  findTodoIdByNumber,
  parseRoute,
  type Route,
  routeForTodo,
} from './route';

/**
 * 웹 UI 상태 — zustand 단일 스토어.
 *
 * 서버가 단일 진실 공급원이므로 UI 는 낙관적 갱신을 하지 않는다:
 * mutation → 서버 확정 → SSE(or 응답) → refetch 로 수렴한다.
 * actor 는 localStorage 에 저장되고 모든 mutation 의 `x-rocky-actor` 헤더로 나간다.
 */

const ACTOR_KEY = 'rocky-todo-actor';

// BoardSelection 은 './route' 가 소유한다 — store 가 route 를 import 하므로 반대 방향은
// 순환이 된다. 기존 import 경로(`from './store'`)를 쓰는 컴포넌트를 위해 재수출한다.
export type { BoardSelection };

interface DetailState {
  kind: 'todo' | 'note';
  todo?: TodoView;
  note?: NoteView;
  history: HistoryEntry[];
}

interface UiState {
  boards: Board[];
  todos: TodoView[];
  sections: Section[];
  notes: NoteView[];
  selected: BoardSelection;
  showArchived: boolean;
  actor: string;
  connected: boolean;
  detail: DetailState | null;

  setSelected: (selection: BoardSelection) => void;
  setShowArchived: (show: boolean) => void;
  setActor: (actor: string) => void;
  setConnected: (connected: boolean) => void;

  refetch: () => Promise<void>;
  /**
   * @param options.push false 면 히스토리 항목을 만들지 않는다. `refetch` 가 열린 상세를
   *   갱신할 때와 `applyRoute` 가 URL 을 따라갈 때 반드시 false 여야 한다 — 아니면
   *   SSE 이벤트 하나마다 히스토리가 한 칸씩 쌓인다.
   */
  openTodoDetail: (id: string, options?: { push?: boolean }) => Promise<void>;
  openNoteDetail: (id: string) => Promise<void>;
  closeDetail: () => void;

  /** URL 이 지정한 화면으로 상태를 맞춘다 — 부팅과 popstate 가 쓴다. */
  applyRoute: (route: Route) => Promise<void>;

  /**
   * 보드 생성 후 그 보드로 전환한다.
   * @throws 서버가 거절한 이유를 그대로 던진다 — key 에 공백/`#` 이 있으면 참조로 쓸 수
   *   없어 400 이 온다. 호출자가 사용자에게 보여줘야 한다 (조용히 삼키면 안 된다).
   */
  createBoard: (key: string) => Promise<void>;
  addTodo: (input: { board: string; title: string; section?: string }) => Promise<void>;
  patchTodo: (id: string, patch: Record<string, unknown>) => Promise<void>;
  setTodoStatus: (id: string, action: StatusAction) => Promise<void>;
  addNote: (input: { board?: string; title: string }) => Promise<void>;
  saveNote: (id: string, patch: { title?: string; content?: string }) => Promise<void>;
  archiveNote: (id: string) => Promise<void>;
}

async function api<T>(path: string, actor: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      'x-rocky-actor': actor,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const useUiStore = create<UiState>((set, get) => ({
  boards: [],
  todos: [],
  sections: [],
  notes: [],
  // 첫 fetch 부터 올바른 보드를 조회하도록 URL 을 먼저 읽는다. 없는 보드였다면
  // 부팅 직후의 applyRoute 가 전체 보기로 되돌린다.
  selected: parseRoute(window.location.pathname).board,
  showArchived: false,
  actor: localStorage.getItem(ACTOR_KEY) ?? 'logan',
  connected: false,
  detail: null,

  setSelected: (selected) => {
    set({ selected });
    window.history.pushState(null, '', buildPath({ board: selected }));
    void get().refetch();
  },
  setShowArchived: (showArchived) => {
    set({ showArchived });
    void get().refetch();
  },
  setActor: (actor) => {
    localStorage.setItem(ACTOR_KEY, actor);
    set({ actor });
  },
  setConnected: (connected) => set({ connected }),

  refetch: async () => {
    const { selected, showArchived, actor, detail } = get();
    const params = new URLSearchParams();
    if (selected !== 'all') {
      params.set('board', selected);
    }
    if (showArchived) {
      params.set('includeArchived', 'true');
    }
    const qs = params.size > 0 ? `?${params.toString()}` : '';

    const [boards, todos, notes, sections] = await Promise.all([
      api<Board[]>('/api/boards', actor),
      api<TodoView[]>(`/api/todos${qs}`, actor),
      api<NoteView[]>(`/api/notes${qs}`, actor),
      selected === 'all'
        ? Promise.resolve([] as Section[])
        : api<Section[]>(`/api/sections?board=${encodeURIComponent(selected)}`, actor),
    ]);
    set({ boards, todos, notes, sections });

    // 열린 상세가 있으면 함께 갱신 (SSE 로 들어온 변경 반영)
    if (detail?.kind === 'todo' && detail.todo) {
      void get().openTodoDetail(detail.todo.id, { push: false });
    } else if (detail?.kind === 'note' && detail.note) {
      void get().openNoteDetail(detail.note.id);
    }
  },

  openTodoDetail: async (id, options) => {
    const { actor, boards } = get();
    const body = await api<{ todo: TodoView; history: HistoryEntry[] }>(`/api/todos/${id}`, actor);
    set({ detail: { kind: 'todo', todo: body.todo, history: body.history } });
    if (options?.push === false) {
      return;
    }
    // 상세를 연 것이 히스토리 항목을 만든다 — closeDetail 이 이 표식을 보고 back() 할지
    // 정한다(퍼머링크로 바로 진입한 경우엔 back() 이 앱 밖으로 나가버린다).
    window.history.pushState(
      { rockyTodoDetail: true },
      '',
      buildPath(routeForTodo(body.todo, boards)),
    );
  },

  openNoteDetail: async (id) => {
    const { actor } = get();
    const body = await api<{ note: NoteView; history: HistoryEntry[] }>(`/api/notes/${id}`, actor);
    set({ detail: { kind: 'note', note: body.note, history: body.history } });
  },

  closeDetail: () => {
    const state = window.history.state as { rockyTodoDetail?: boolean } | null;
    if (state?.rockyTodoDetail) {
      // 우리가 만든 항목이니 뒤로가기로 되돌린다 — popstate 가 detail 을 닫는다.
      window.history.back();
      return;
    }
    // 퍼머링크로 바로 들어온 경우: 되돌릴 항목이 없다. back() 하면 앱 밖으로 나간다.
    set({ detail: null });
    window.history.replaceState(null, '', buildPath({ board: get().selected }));
  },

  createBoard: async (key) => {
    const { actor } = get();
    const board = await api<Board>('/api/boards', actor, {
      method: 'POST',
      body: JSON.stringify({ key }),
    });
    // selected 를 먼저 바꾼 뒤 조회한다 — 순서가 반대면 refetch 가 이전 보드 기준으로
    // 돌아, 새 보드 화면에 직전 보드의 항목·섹션이 그대로 남는다.
    set({ selected: board.key });
    window.history.pushState(null, '', buildPath({ board: board.key }));
    await get().refetch();
  },

  applyRoute: async (route) => {
    const known = route.board === 'all' || get().boards.some((b) => b.key === route.board);
    const board: BoardSelection = known ? route.board : 'all';
    if (!known) {
      // 낡은 링크에 에러 화면을 띄우지 않는다. 히스토리에 죽은 항목을 남기지 않으려
      // push 가 아니라 replace 를 쓴다.
      window.history.replaceState(null, '', buildPath({ board: 'all' }));
    }
    if (board !== get().selected) {
      set({ selected: board });
      await get().refetch();
    }
    if (route.todoNumber === undefined) {
      set({ detail: null });
      return;
    }
    const id = findTodoIdByNumber(get().todos, get().boards, board, route.todoNumber);
    if (id === undefined) {
      // 없거나 보관된 번호 — 보드만 열어 준다.
      set({ detail: null });
      window.history.replaceState(null, '', buildPath({ board }));
      return;
    }
    await get().openTodoDetail(id, { push: false });
  },

  addTodo: async (input) => {
    const { actor } = get();
    await api('/api/todos', actor, { method: 'POST', body: JSON.stringify(input) });
    await get().refetch();
  },

  patchTodo: async (id, patch) => {
    const { actor } = get();
    await api(`/api/todos/${id}`, actor, { method: 'PATCH', body: JSON.stringify(patch) });
    await get().refetch();
  },

  setTodoStatus: async (id, action) => {
    const { actor } = get();
    await api(`/api/todos/${id}/status`, actor, {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
    await get().refetch();
  },

  addNote: async (input) => {
    const { actor } = get();
    await api('/api/notes', actor, { method: 'POST', body: JSON.stringify(input) });
    await get().refetch();
  },

  saveNote: async (id, patch) => {
    const { actor } = get();
    await api(`/api/notes/${id}`, actor, { method: 'PATCH', body: JSON.stringify(patch) });
    await get().refetch();
  },

  archiveNote: async (id) => {
    const { actor } = get();
    await api(`/api/notes/${id}/archive`, actor, { method: 'POST' });
    set({ detail: null });
    await get().refetch();
  },
}));
