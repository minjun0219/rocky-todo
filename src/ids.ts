import { randomBytes } from 'node:crypto';

/**
 * 엔티티 id 생성과 그 길이 — `store` 와 `refs` 가 **양쪽 다** 필요로 하는 값이라 여기 둔다.
 *
 * 왜 별도 모듈인가: `refs.ts` 는 참조 해석에 `ID_LENGTH` 가 필요하고(짧은 순수 숫자는
 * 번호, 그 이상은 id), `store.ts` 는 `refs.ts` 의 `refOf` 를 쓴다. 이 상수가 `store.ts` 에
 * 있으면 둘이 런타임 순환 import 가 된다 — 지금은 함수 본문 안에서만 접근해 우연히
 * 동작하지만, 모듈 초기화 시점에 값이 필요해지는 순간 `undefined` 로 깨진다. 값 하나를
 * 아래로 내려 순환을 끊는다 (타입 참조는 `import type` 이라 런타임에 남지 않는다).
 */

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** 랜덤 id 길이 — 참조 해석이 "번호냐 id 냐"를 가르는 기준이라 상수로 묶어 둔다. */
export const ID_LENGTH = 8;

/** 8자 base36 랜덤 id — 짧아서 CLI/대화에서 다루기 좋고 prefix 매칭을 허용한다. */
export function newId(): string {
  const bytes = randomBytes(ID_LENGTH);
  let id = '';
  for (const b of bytes) {
    id += ID_ALPHABET[b % 36];
  }
  return id;
}
