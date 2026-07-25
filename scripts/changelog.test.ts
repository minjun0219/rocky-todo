import { describe, expect, it } from 'bun:test';
import { extractChangelogSection } from './changelog';

const SAMPLE = `# @minjun0219/rocky

## 0.11.0

### Minor Changes

- a881fb8: changesets 도입

## 0.10.0

### Minor Changes

- soul / opencode
`;

describe('extractChangelogSection', () => {
  it('최상단 버전 섹션 본문만 추출한다 (다음 ## 전까지)', () => {
    const notes = extractChangelogSection(SAMPLE, '0.11.0');
    expect(notes).toBe('### Minor Changes\n\n- a881fb8: changesets 도입');
  });

  it('중간 버전 섹션도 추출한다', () => {
    const notes = extractChangelogSection(SAMPLE, '0.10.0');
    expect(notes).toBe('### Minor Changes\n\n- soul / opencode');
  });

  it('없는 버전은 빈 문자열', () => {
    expect(extractChangelogSection(SAMPLE, '9.9.9')).toBe('');
  });

  it('빈 CHANGELOG 는 빈 문자열', () => {
    expect(extractChangelogSection('', '0.11.0')).toBe('');
  });

  it('CRLF 개행도 \\r 없이 추출한다', () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n');
    const notes = extractChangelogSection(crlf, '0.11.0');
    expect(notes).toBe('### Minor Changes\n\n- a881fb8: changesets 도입');
  });
});
