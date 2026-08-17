import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { readThemePref, resolveTheme } from './lib';

/**
 * `index.html` 인라인 테마 스크립트의 회귀 가드.
 *
 * 이 스크립트는 첫 페인트 전에 돌아야 해서 `lib.ts` 를 import 하지 못하고
 * `readThemePref`/`resolveTheme` 규칙을 손으로 복제하고 있다. 복제는 갈라지기 마련이라
 * 여기서 **실제 스크립트 텍스트를 실행해** 두 경로가 같은 결론에 이르는지 본다 —
 * 스크립트를 테스트에 복사하지 않으므로, HTML 만 고쳤을 때 낡은 사본을 검사하며
 * 통과하는 일이 없다.
 */

const HTML = readFileSync(join(import.meta.dir, 'index.html'), 'utf8');

/** head 의 클래식 인라인 스크립트 — `src` 가 붙은 모듈 스크립트는 제외한다. */
function extractInlineScript(): string {
  const match = HTML.match(/<script>([\s\S]*?)<\/script>/);
  if (match?.[1] === undefined) {
    throw new Error('index.html 에서 인라인 테마 스크립트를 찾지 못했다');
  }
  return match[1];
}

const SCRIPT = extractInlineScript();

type StorageBehavior = { value: string | null } | { throws: true };

/**
 * 인라인 스크립트를 격리된 스텁 위에서 실행하고 확정된 `data-theme` 을 돌려준다.
 * 속성이 끝내 안 붙으면 `undefined` — CSS 의 `:root` 다크 폴백이 받는 경우다.
 */
function runScript(storage: StorageBehavior, prefersLight: boolean): string | undefined {
  const dataset: { theme?: string } = {};
  const documentStub = { documentElement: { dataset } };
  const windowStub = {
    matchMedia(query: string) {
      return { matches: query.includes('light') ? prefersLight : !prefersLight };
    },
  };
  const localStorageStub = {
    getItem(_key: string): string | null {
      if ('throws' in storage) {
        throw new Error('저장소가 차단됐다');
      }
      return storage.value;
    },
  };

  // 스크립트 텍스트 자체가 검사 대상이라 실행해서 본다. 전역 대신 인자로 스텁을 넘기므로
  // 이 프로세스의 진짜 window/document/localStorage 에는 닿지 않는다.
  new Function('window', 'document', 'localStorage', SCRIPT)(
    windowStub,
    documentStub,
    localStorageStub,
  );
  return dataset.theme;
}

describe('index.html 인라인 테마 스크립트', () => {
  test('저장값 × OS 조합 전부가 resolveTheme 과 같은 결론을 낸다', () => {
    for (const stored of ['dark', 'light', 'auto', null, '', 'garbage']) {
      for (const prefersLight of [true, false]) {
        expect(
          runScript({ value: stored }, prefersLight),
          `stored=${JSON.stringify(stored)} prefersLight=${prefersLight}`,
        ).toBe(resolveTheme(readThemePref(stored), prefersLight));
      }
    }
  });

  /*
   * 프라이빗 모드/사이트 데이터 차단에서 localStorage 는 읽기부터 던진다. store 의
   * safeStorage 는 이때 null 을 돌려주므로 themePref 가 `auto` 로 출발한다. 인라인
   * 스크립트가 여기서 "dark" 로 단정하면 화면만 다크로 굳는데, main.tsx 의 auto 추종
   * effect 는 리스너만 걸고 마운트 시점에 재해석하지 않는다 — 라이트 OS 사용자가 OS
   * 설정을 손대기 전까지 다크에 갇힌다.
   */
  test('저장소가 던져도 OS 를 따른다 — 다크로 단정하지 않는다', () => {
    expect(runScript({ throws: true }, true)).toBe('light');
    expect(runScript({ throws: true }, false)).toBe('dark');
  });

  test('저장소가 던진 경우의 결론이 store 의 읽기 실패 처리(null → auto)와 같다', () => {
    for (const prefersLight of [true, false]) {
      expect(runScript({ throws: true }, prefersLight)).toBe(
        resolveTheme(readThemePref(null), prefersLight),
      );
    }
  });

  test('명시 선택은 OS 와 무관하게 유지된다', () => {
    expect(runScript({ value: 'dark' }, true)).toBe('dark');
    expect(runScript({ value: 'light' }, false)).toBe('light');
  });
});
