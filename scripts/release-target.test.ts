import { describe, expect, it } from 'bun:test';
import { assertTagMatchesTarget, resolveTargetSha } from './release-target';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER = 'fdbf9dd0000000000000000000000000000000ff';

describe('resolveTargetSha', () => {
  it('CI 에서 GITHUB_SHA 와 HEAD 가 같으면 그 커밋을 쓴다', () => {
    expect(resolveTargetSha({ githubSha: SHA, headSha: SHA })).toBe(SHA);
  });

  it('GITHUB_SHA 가 없으면(로컬 실행) HEAD 를 그대로 쓴다', () => {
    expect(resolveTargetSha({ headSha: SHA })).toBe(SHA);
    expect(resolveTargetSha({ githubSha: '  ', headSha: SHA })).toBe(SHA);
  });

  it('앞뒤 공백은 무시한다', () => {
    expect(resolveTargetSha({ githubSha: `${SHA}\n`, headSha: ` ${SHA} ` })).toBe(SHA);
  });

  // 실제로 났던 사고의 재현: changesets 가 Version PR 브랜치로 트리를 옮긴 뒤 릴리스 스텝이 돌았다.
  it('HEAD 가 GITHUB_SHA 와 다르면 조용히 태그하지 않고 실패한다', () => {
    expect(() => resolveTargetSha({ githubSha: SHA, headSha: OTHER })).toThrow(
      /릴리스 대상 커밋이 어긋났다/,
    );
  });

  it('실패 메시지에 두 sha 를 모두 담아 진단할 수 있게 한다', () => {
    expect(() => resolveTargetSha({ githubSha: SHA, headSha: OTHER })).toThrow(
      new RegExp(`${SHA}[\\s\\S]*${OTHER}`),
    );
  });

  it('HEAD 를 못 읽으면 실패한다', () => {
    expect(() => resolveTargetSha({ githubSha: SHA, headSha: '' })).toThrow(/HEAD sha/);
  });
});

describe('assertTagMatchesTarget', () => {
  it('태그가 아직 없으면 통과한다 (gh 가 --target 으로 만든다)', () => {
    expect(() => assertTagMatchesTarget({ tag: 'v0.9.0', targetSha: SHA })).not.toThrow();
    expect(() =>
      assertTagMatchesTarget({ tag: 'v0.9.0', tagSha: '  ', targetSha: SHA }),
    ).not.toThrow();
  });

  it('기존 태그가 같은 커밋이면 통과한다 (부분 실패 복구 경로)', () => {
    expect(() =>
      assertTagMatchesTarget({ tag: 'v0.9.0', tagSha: `${SHA}\n`, targetSha: SHA }),
    ).not.toThrow();
  });

  // v0.5.0~v0.8.0 정리 시 밟게 되는 함정: 릴리스만 지우고 재생성하면 잘못된 태그에 다시 붙는다.
  it('기존 태그가 다른 커밋이면 멈춘다', () => {
    expect(() => assertTagMatchesTarget({ tag: 'v0.8.0', tagSha: OTHER, targetSha: SHA })).toThrow(
      /이미 다른 커밋을 가리킨다/,
    );
  });

  it('실패 메시지가 태그 삭제 방법을 알려준다', () => {
    expect(() => assertTagMatchesTarget({ tag: 'v0.8.0', tagSha: OTHER, targetSha: SHA })).toThrow(
      /git push origin :refs\/tags\/v0\.8\.0/,
    );
  });
});
