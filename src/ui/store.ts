import { create } from 'zustand';
import type { NoteView, TodoView } from '../server';
import type { Board, Comment, HistoryEntry, Section, StatusAction } from '../store';
import { markSeen, readSeen } from './lib';
import {
  type BoardSelection,
  buildPath,
  findTodoIdByNumber,
  isAddressableBoardKey,
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
  comments: Comment[];
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
  /** todo id → 마지막으로 확인한 댓글 시각. localStorage 의 화면용 사본. */
  seenComments: Record<string, string>;

  setSelected: (selection: BoardSelection) => void;
  setShowArchived: (show: boolean) => void;
  setActor: (actor: string) => void;
  setConnected: (connected: boolean) => void;

  refetch: () => Promise<void>;
  /**
   * @param options.push false 면 히스토리 항목을 만들지 않는다. `refetch` 가 열린 상세를
   *   갱신할 때와 `applyRoute` 가 URL 을 따라갈 때 반드시 false 여야 한다 — 아니면
   *   SSE 이벤트 하나마다 히스토리가 한 칸씩 쌓인다.
   * @param options.refresh true 면 **이미 그 항목이 열려 있을 때만** 반영한다. `refetch`
   *   전용 — 그쪽은 "열린 상세 갱신"이라 응답이 늦게 도착했는데 그새 드로어가 닫혔거나
   *   다른 항목으로 바뀌었다면 되살리지 말아야 한다.
   */
  openTodoDetail: (id: string, options?: { push?: boolean; refresh?: boolean }) => Promise<void>;
  openNoteDetail: (id: string, options?: { refresh?: boolean }) => Promise<void>;
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
  addComment: (todoId: string, body: string) => Promise<void>;
  editComment: (id: string, body: string) => Promise<void>;
  archiveComment: (id: string) => Promise<void>;
  unarchiveComment: (id: string) => Promise<void>;
  /**
   * todo 를 GitHub 이슈로 만든다.
   * @throws 서버가 거절한 이유를 그대로 던진다 — 보드에 repo 가 없거나(400), 이미 이슈가
   *   있거나(409), gh 가 실패한 경우다. 호출자가 사용자에게 보여줘야 한다.
   */
  createIssue: (todoId: string) => Promise<void>;
  /** 보드의 GitHub 레포를 설정한다. @throws 모양이 틀리면 400 을 그대로 던진다. */
  setBoardRepo: (key: string, repo: string) => Promise<void>;
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

/**
 * 주소가 이미 `path` 면 아무것도 하지 않고, 아니면 히스토리 항목을 **더하지 않고** 갈아끼운다.
 *
 * 항상 부르는 대신 비교를 먼저 하는 이유: `replaceState` 는 히스토리 길이를 늘리지 않지만
 * 현재 항목의 state 를 덮어쓴다. 상세 드로어 마커(`rockyTodoDetail`)가 그 state 에 있어서,
 * 불필요한 호출이 마커를 지우면 `closeDetail` 이 뒤로가기 대신 잘못된 분기를 고른다.
 */
function replacePath(path: string, state: unknown = null): void {
  if (window.location.pathname !== path) {
    window.history.replaceState(state, '', path);
  }
}

/**
 * 주소가 실제로 바뀔 때만 히스토리 항목을 만든다.
 *
 * `buildPath` 가 `/` 로 접는 보드(예약어 `api`/`mcp`, 점 세그먼트)에서는 이미 `/` 에 있는
 * 채로 push 하면 **되읽을 수 없는 항목**이 쌓인다 — 뒤로가기가 그 항목으로 돌아가면
 * popstate 가 `/` 를 전체 보기로 읽어 보드 선택이 엉뚱하게 풀린다.
 *
 * @returns 항목을 만들었으면 true.
 */
function pushPath(path: string, state: unknown = null): boolean {
  if (window.location.pathname === path) {
    return false;
  }
  window.history.pushState(state, '', path);
  return true;
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
  seenComments: readSeen(localStorage),

  setSelected: (selected) => {
    // 같은 보드를 다시 고른 클릭도 refetch 는 그대로 수행한다(새로고침 용도로 쓰인다) —
    // 다만 선택이 실제로 바뀌지 않았으면 pushState 는 건너뛴다. 아니면 전체/같은 보드를
    // 다섯 번 눌렀을 때 동일한 히스토리 항목이 다섯 개 쌓여 뒤로가기를 다섯 번 눌러야
    // 벗어나게 된다.
    if (selected !== get().selected) {
      // 보드를 바꾸면 열린 상세도 닫는다 — 주소는 새 보드를 가리키는데 드로어가 이전
      // 보드의 todo 를 계속 띄우면, 같은 주소를 새로고침한 화면과 달라진다.
      set({ selected, detail: null });
      pushPath(buildPath({ board: selected }));
    }
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

    // 열린 상세가 있으면 함께 갱신 (SSE 로 들어온 변경 반영). await 하지 않으므로
    // `refresh: true` 로 "그 항목이 아직 열려 있을 때만" 반영하게 한다 — 그 사이 라우팅이
    // 드로어를 닫았다면(뒤로가기 등) 늦게 도착한 이 응답이 되살려선 안 된다.
    if (detail?.kind === 'todo' && detail.todo) {
      void get().openTodoDetail(detail.todo.id, { push: false, refresh: true });
    } else if (detail?.kind === 'note' && detail.note) {
      void get().openNoteDetail(detail.note.id, { refresh: true });
    }
  },

  openTodoDetail: async (id, options) => {
    const { actor, showArchived } = get();
    // 전역 "보관 항목 보기" 토글을 댓글에도 그대로 연결한다 — 별도 스위치를 만들지
    // 않고 이미 있는 컨트롤 하나로 todo/note/comment 아카이브 뷰를 통일한다.
    const qs = showArchived ? '?includeArchived=true' : '';
    const body = await api<{ todo: TodoView; history: HistoryEntry[]; comments: Comment[] }>(
      `/api/todos/${id}${qs}`,
      actor,
    );
    if (options?.refresh && get().detail?.todo?.id !== id) {
      // 갱신하려던 상세가 await 도중 닫혔거나 다른 항목으로 바뀌었다 — 늦게 온 응답을 버린다.
      return;
    }
    set({
      detail: { kind: 'todo', todo: body.todo, history: body.history, comments: body.comments },
    });
    // 드로어를 연 시점에 이 todo 의 댓글은 모두 확인한 것으로 본다. localStorage(세션 간
    // 유지)와 상태 사본(리렌더 트리거)을 함께 갱신한다. push 여부와 무관하게 수행한다 —
    // URL 로 연 경우(applyRoute)도, SSE refetch 로 갱신된 경우도 사용자는 그 댓글을 보고 있다.
    if (body.todo.lastCommentAt) {
      markSeen(localStorage, body.todo.id, body.todo.lastCommentAt);
      set({ seenComments: readSeen(localStorage) });
    }
    if (options?.push === false) {
      return;
    }
    // boards 는 await 이후 다시 읽는다 — await 도중 SSE 로 새 보드가 들어와 배열이 바뀔 수
    // 있고, 낡은 배열을 쓰면 routeForTodo 가 boardId 를 못 찾아 { board: 'all' } 로 잘못
    // 폴백한다(상세는 열려 있는데 주소는 전체 보기가 되는 불일치).
    const route = routeForTodo(body.todo, get().boards);
    if (route.board === 'all' || !isAddressableBoardKey(route.board)) {
      // 이 상세를 가리킬 주소가 없다(보드를 못 찾았거나 `buildPath` 가 `/` 로 접는 키).
      // 그래도 마커만 쌓으면 closeDetail 이 back() 을 골라, popstate 가 `/` 를 전체 보기로
      // 읽어 **닫기가 보드 전환을 일으킨다**. 항목을 만들지 않으면 closeDetail 의
      // replaceState 분기가 지금 보드를 그대로 들고 드로어만 닫는다.
      return;
    }
    // 주소가 이 보드를 가리키게 되었으니 선택도 맞춘다. 전체 보기에서 연 상세가
    // `/rocky/12` 를 push 하고 selected 는 'all' 로 남으면, 같은 히스토리 항목이 새로고침·
    // 앞으로가기에서는 applyRoute 를 통해 rocky 보드로 복원되어 진입 방식마다 다른 화면이 된다.
    if (route.board !== get().selected) {
      set({ selected: route.board });
      void get().refetch();
    }
    // 상세를 연 것이 히스토리 항목을 만든다 — closeDetail 이 이 표식을 보고 back() 할지
    // 정한다(퍼머링크로 바로 진입한 경우엔 back() 이 앱 밖으로 나가버린다).
    pushPath(buildPath(route), { rockyTodoDetail: true });
  },

  openNoteDetail: async (id, options) => {
    const { actor } = get();
    const body = await api<{ note: NoteView; history: HistoryEntry[] }>(`/api/notes/${id}`, actor);
    if (options?.refresh && get().detail?.note?.id !== id) {
      // openTodoDetail 과 같은 규칙 — 늦게 도착한 갱신이 닫힌 드로어를 되살리지 않는다.
      return;
    }
    set({ detail: { kind: 'note', note: body.note, history: body.history, comments: [] } });
  },

  closeDetail: () => {
    const state = window.history.state as { rockyTodoDetail?: boolean } | null;
    if (state?.rockyTodoDetail) {
      // 우리가 만든 항목이니 뒤로가기로 되돌린다. popstate 의 applyRoute 도 어차피 닫지만,
      // 닫힘은 여기서 먼저 확정한다 — 사용자가 누른 것은 "닫기"이지 "뒤로"가 아니라서,
      // popstate 가 늦거나(back() 은 비동기다) 어떤 이유로 처리되지 않아도 드로어가 열린 채
      // 주소만 바뀌는 상태로 남으면 안 된다. 되돌아갈 항목은 늘 상세가 없는 보드 경로다
      // (드로어가 열려 있는 동안에는 백드롭이 목록 클릭을 막아 상세→상세 전환이 없다).
      set({ detail: null });
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
    set({ selected: board.key, detail: null });
    pushPath(buildPath({ board: board.key }));
    await get().refetch();
  },

  applyRoute: async (route) => {
    const known = route.board === 'all' || get().boards.some((b) => b.key === route.board);
    const board: BoardSelection = known ? route.board : 'all';
    if (!known) {
      // 낡은 링크에 에러 화면을 띄우지 않는다. 히스토리에 죽은 항목을 남기지 않으려
      // push 가 아니라 replace 를 쓴다. 아래 정규화가 어차피 같은 일을 하지만, 그 전의
      // refetch 가 실패해도 죽은 주소는 남지 않도록 여기서 먼저 걷어낸다.
      replacePath(buildPath({ board: 'all' }));
    }
    if (board !== get().selected) {
      set({ selected: board });
      await get().refetch();
    }
    if (route.todoNumber === undefined) {
      set({ detail: null });
      // `/demo/abc` 처럼 해석되지 않은 꼬리가 주소에 남지 않게 정규화한다.
      // push 가 아니라 replace 인 이유: 히스토리에 죽은 항목을 남기지 않는다.
      replacePath(buildPath({ board }));
      return;
    }
    const id = findTodoIdByNumber(get().todos, get().boards, board, route.todoNumber);
    if (id === undefined) {
      // 없거나 보관된 번호 — 보드만 열어 준다.
      set({ detail: null });
      replacePath(buildPath({ board }));
      return;
    }
    await get().openTodoDetail(id, { push: false });
    // 번호가 해석된 경로도 똑같이 정규화한다 — `/demo/12/extra` 의 꼬리 세그먼트를
    // parseRoute 는 무시하지만 주소에는 남아, 같은 화면이 여러 주소를 갖게 되고 복사해
    // 건넨 링크에 죽은 꼬리가 따라간다. 여기서는 현재 항목의 state(상세 마커)를 보존해야
    // 한다 — 지우면 closeDetail 이 back() 대신 replace 분기를 골라 뒤로가기가 어긋난다.
    replacePath(buildPath({ board, todoNumber: route.todoNumber }), window.history.state);
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

  addComment: async (todoId, body) => {
    const { actor } = get();
    await api(`/api/todos/${todoId}/comments`, actor, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    await get().refetch();
  },

  editComment: async (id, body) => {
    const { actor } = get();
    await api(`/api/comments/${id}`, actor, { method: 'PATCH', body: JSON.stringify({ body }) });
    await get().refetch();
  },

  archiveComment: async (id) => {
    const { actor } = get();
    await api(`/api/comments/${id}/archive`, actor, { method: 'POST' });
    await get().refetch();
  },

  unarchiveComment: async (id) => {
    const { actor } = get();
    await api(`/api/comments/${id}/unarchive`, actor, { method: 'POST' });
    await get().refetch();
  },

  createIssue: async (todoId) => {
    const { actor } = get();
    await api(`/api/todos/${todoId}/issue`, actor, { method: 'POST' });
    await get().refetch();
  },

  setBoardRepo: async (key, repo) => {
    const { actor } = get();
    await api(`/api/boards/${encodeURIComponent(key)}`, actor, {
      method: 'PATCH',
      body: JSON.stringify({ repo }),
    });
    await get().refetch();
  },
}));
