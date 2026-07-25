import type { Note, Todo, TodoStore } from './store';

/**
 * REST 와 MCP 가 공유하는 ref 직렬화 — 저장 모델에 사람이 읽는 참조(`rocky#12`)를 얹는다.
 *
 * 원래 `server.ts` 안에 `buildTodoServer` 클로저로만 있었다. MCP 도구가 store 모델을
 * 그대로 반환해 REST 와 응답 계약이 갈라졌던 문제(설계 스펙: REST·MCP 모두 number/ref 를
 * 실어야 한다)를 고치면서, 두 표면이 같은 로직을 복붙하지 않고 여기서 공유하게 뺐다.
 */

/** 응답 전용 todo — 저장 모델에 사람이 쓰는 참조(ref)를 얹은 형태. */
export interface TodoView extends Todo {
  /** `rocky#12` — 보드 접두사를 포함한 완전 참조. */
  ref: string;
}

/** 응답 전용 note. 글로벌 메모는 보드 접두사가 없어 `#3` 이 된다. */
export interface NoteView extends Note {
  ref: string;
}

/**
 * boardId + number 로 사람이 읽는 참조 문자열을 만든다.
 * @throws boardId 는 있는데 그 보드가 store 에 없으면(FK 가 깨진 상태) — 조용히
 *   `#12` 같은 위조 글로벌 참조를 만들면 다른(진짜 글로벌) 엔티티를 가리키는 것과
 *   구분이 안 돼 사고를 부르므로 명시적으로 실패시킨다.
 */
export function refOf(store: TodoStore, boardId: string | undefined, number: number): string {
  if (!boardId) {
    return `#${number}`;
  }
  const key = store.boardKeyOf(boardId);
  if (!key) {
    throw new Error(`cannot build ref: board not found for boardId ${boardId}`);
  }
  return `${key}#${number}`;
}

/**
 * 응답용 직렬화 — 저장 모델에 ref 를 얹는다.
 * 오버로드 시그니처로 반환형을 `TodoView`/`NoteView` 에 고정한다 — 구현부를
 * 제네릭으로 느슨하게 두면 그 두 인터페이스가 실제로 강제되지 않아 드리프트할 수 있다.
 */
export function withRef(store: TodoStore, entity: Todo): TodoView;
export function withRef(store: TodoStore, entity: Note): NoteView;
export function withRef(store: TodoStore, entity: Todo | Note): TodoView | NoteView {
  return { ...entity, ref: refOf(store, entity.boardId, entity.number) };
}
