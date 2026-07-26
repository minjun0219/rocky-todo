import { ID_LENGTH } from './store';
import type { Note, Todo, TodoStore } from './store';

/**
 * REST 와 MCP 가 공유하는 ref 직렬화 — 저장 모델에 사람이 읽는 참조(`rocky#12`)를 얹는다.
 *
 * 원래 `server.ts` 안에 `buildTodoServer` 클로저로만 있었다. MCP 도구가 store 모델을
 * 그대로 반환해 REST 와 응답 계약이 갈라졌던 문제(설계 스펙: REST·MCP 모두 number/ref 를
 * 실어야 한다)를 고치면서, 두 표면이 같은 로직을 복붙하지 않고 여기서 공유하게 뺐다.
 */

/** 응답 전용 todo — 저장 모델에 사람이 쓰는 참조(ref)와 댓글 집계를 얹은 형태. */
export interface TodoView extends Todo {
  /** `rocky#12` — 보드 접두사를 포함한 완전 참조. */
  ref: string;
  /** 보관되지 않은 댓글 수 — 목록의 배지용. */
  commentCount: number;
  /** 가장 최근 댓글 시각(ISO). 댓글이 없으면 undefined. */
  lastCommentAt?: string;
}

/** 응답 전용 note. 글로벌 메모는 보드 접두사가 없어 `#3` 이 된다. */
export interface NoteView extends Note {
  ref: string;
}

/**
 * board key 가 `resolveRef` 의 스코프 정규식(`^([^#\s]+)#(\d+)$`)이 되읽을 수 있는
 * `<key>#<number>` 를 만들 수 있는 모양인지 판별한다. `refNeedsBoardContext` 와 같은
 * 방식으로 `resolveRef` 의 조건을 손으로 옮긴 predicate 다(공유는 안 하고 계약 테스트로
 * 고정) — key 캡처 그룹이 거부하는 두 문자 부류(공백, `#`)와 빈 문자열만 걸러내면 된다.
 *
 * `ensureBoard` 는 board key 검증을 **새 보드 생성**에만 적용한다(`src/store.ts`) — 검증
 * 도입 전 구버전 데몬이 `my repo` 같은 malformed key 로 만들어둔 보드는 조회로 계속
 * 살아남는다. 그런 레거시 보드의 항목에 `refOf` 가 `my repo#1` 같은, `resolveRef` 스스로
 * 못 읽는 ref 를 내보내면 웹 UI 가 그대로 보여주고 복사해도 붙여넣기가 항상 실패한다 —
 * 이 predicate 로 그 경우를 감지해 `refOf` 가 raw id 로 폴백하게 한다.
 */
export function isRefSafeBoardKey(key: string): boolean {
  return key !== '' && !/[#\s]/.test(key);
}

/**
 * boardId + number 로 사람이 읽는 참조 문자열을 만든다. board key 가
 * {@link isRefSafeBoardKey} 를 만족하지 않으면(레거시 malformed key) `resolveRef` 가
 * 못 읽는 문자열을 내보내는 대신 `id` 로 폴백한다 — raw id 는 항상 `resolveRef` 의 id/
 * id-prefix 분기로 되읽히므로 클릭 복사→붙여넣기 왕복이 깨지지 않는다. 덜 예쁠 뿐이다.
 * @throws boardId 는 있는데 그 보드가 store 에 없으면(FK 가 깨진 상태) — 조용히
 *   `#12` 같은 위조 글로벌 참조를 만들면 다른(진짜 글로벌) 엔티티를 가리키는 것과
 *   구분이 안 돼 사고를 부르므로 명시적으로 실패시킨다.
 */
export function refOf(
  store: TodoStore,
  boardId: string | undefined,
  number: number,
  id: string,
): string {
  if (!boardId) {
    return `#${number}`;
  }
  const key = store.boardKeyOf(boardId);
  if (key === undefined) {
    throw new Error(`cannot build ref: board not found for boardId ${boardId}`);
  }
  if (!isRefSafeBoardKey(key)) {
    return id;
  }
  return `${key}#${number}`;
}

/**
 * ref 가 board 컨텍스트(`currentBoardId`)를 실제로 소비하는 "맨숫자" 꼴인지 판별한다.
 * `TodoStore.resolveRef` 의 네 분기(`rocky#12` 스코프 / 맨숫자 / id 정확 일치 / id
 * prefix) 중 맨숫자 분기만 `currentBoardId` 를 쓴다 — 나머지 세 분기는 완전히
 * 무시한다. 그래서 `?board=`/MCP `board` 인자가 안 풀릴 때(오타 등) 에러를 던져야
 * 하는지는 ref 모양에 달려 있다: 스코프/id/id-prefix ref 에 안 풀리는 board 를 얹고
 * 무조건 던지면(과거 버그 — 리뷰에서 지적됨) `rocky#12` 를 그대로 복사해 쓰거나 raw
 * id 로 조회하는, board 컨텍스트가 애초에 필요 없는 요청까지 무관한 board 오타에
 * 막혀버린다. 판정 로직은 `resolveRef` 의 bare 정규식·길이 조건과 반드시 같아야
 * 한다(짧은 순수 숫자는 번호, `ID_LENGTH` 이상 길이의 순수 숫자는 id/id-prefix 로
 * 갈리는 경계까지 포함) — 어긋나면 이 판별이 "board 없이도 되는 ref" 인데 던지거나,
 * 반대로 "board 가 꼭 필요한 ref" 인데 조용히 넘기는 새로운 wrong-row 구멍이 된다.
 */
export function refNeedsBoardContext(ref: string): boolean {
  const bare = /^(#)?(\d+)$/.exec(ref.trim());
  const digits = bare?.[2];
  if (!digits) {
    return false;
  }
  return Boolean(bare?.[1]) || digits.length < ID_LENGTH;
}

/** `Todo` 와 `Note` 를 가른다 — `status` 는 todo 에만 있다. */
function isTodo(entity: Todo | Note): entity is Todo {
  return 'status' in entity;
}

/**
 * 응답용 직렬화 — 저장 모델에 ref 를 얹는다.
 * 오버로드 시그니처로 반환형을 `TodoView`/`NoteView` 에 고정한다 — 구현부를
 * 제네릭으로 느슨하게 두면 그 두 인터페이스가 실제로 강제되지 않아 드리프트할 수 있다.
 */
export function withRef(store: TodoStore, entity: Todo): TodoView;
export function withRef(store: TodoStore, entity: Note): NoteView;
export function withRef(store: TodoStore, entity: Todo | Note): TodoView | NoteView {
  const ref = refOf(store, entity.boardId, entity.number, entity.id);
  if (!isTodo(entity)) {
    return { ...entity, ref };
  }
  const stats = store.commentStatsOf(entity.id);
  return { ...entity, ref, commentCount: stats.count, lastCommentAt: stats.lastAt };
}
