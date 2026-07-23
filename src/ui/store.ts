import { create } from 'zustand';
import type { Board, HistoryEntry, Note, Section, StatusAction, Todo } from '../store';

/**
 * 웹 UI 상태 — zustand 단일 스토어.
 *
 * 서버가 단일 진실 공급원이므로 UI 는 낙관적 갱신을 하지 않는다:
 * mutation → 서버 확정 → SSE(or 응답) → refetch 로 수렴한다.
 * actor 는 localStorage 에 저장되고 모든 mutation 의 `x-rocky-actor` 헤더로 나간다.
 */

const ACTOR_KEY = 'rocky-todo-actor';

export type BoardSelection = 'all' | string;

interface DetailState {
  kind: 'todo' | 'note';
  todo?: Todo;
  note?: Note;
  history: HistoryEntry[];
}

interface UiState {
  boards: Board[];
  todos: Todo[];
  sections: Section[];
  notes: Note[];
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
  openTodoDetail: (id: string) => Promise<void>;
  openNoteDetail: (id: string) => Promise<void>;
  closeDetail: () => void;

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
  selected: 'all',
  showArchived: false,
  actor: localStorage.getItem(ACTOR_KEY) ?? 'logan',
  connected: false,
  detail: null,

  setSelected: (selected) => {
    set({ selected });
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
      api<Todo[]>(`/api/todos${qs}`, actor),
      api<Note[]>(`/api/notes${qs}`, actor),
      selected === 'all'
        ? Promise.resolve([] as Section[])
        : api<Section[]>(`/api/sections?board=${encodeURIComponent(selected)}`, actor),
    ]);
    set({ boards, todos, notes, sections });

    // 열린 상세가 있으면 함께 갱신 (SSE 로 들어온 변경 반영)
    if (detail?.kind === 'todo' && detail.todo) {
      void get().openTodoDetail(detail.todo.id);
    } else if (detail?.kind === 'note' && detail.note) {
      void get().openNoteDetail(detail.note.id);
    }
  },

  openTodoDetail: async (id) => {
    const { actor } = get();
    const body = await api<{ todo: Todo; history: HistoryEntry[] }>(`/api/todos/${id}`, actor);
    set({ detail: { kind: 'todo', todo: body.todo, history: body.history } });
  },

  openNoteDetail: async (id) => {
    const { actor } = get();
    const body = await api<{ note: Note; history: HistoryEntry[] }>(`/api/notes/${id}`, actor);
    set({ detail: { kind: 'note', note: body.note, history: body.history } });
  },

  closeDetail: () => set({ detail: null }),

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
