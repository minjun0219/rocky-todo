import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { buildUi } from './build';

describe('buildUi', () => {
  const out = mkdtempSync(join(tmpdir(), 'rocky-ui-build-'));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  test('index.html 과 js/css 청크를 outdir 에 만든다', async () => {
    await buildUi(out);
    expect(existsSync(join(out, 'index.html'))).toBe(true);
    const files = readdirSync(out);
    expect(files.some((f) => f.endsWith('.js'))).toBe(true);
    expect(files.some((f) => f.endsWith('.css'))).toBe(true);
  });

  test('index.html 이 청크를 절대 경로로 참조한다', async () => {
    // 정적 서빙에서 퍼머링크(`/rocky/12`)로 새로고침해도 자산 경로가 깨지지 않아야 한다 —
    // 상대 경로면 `/rocky/chunk-*.css` 를 찾다 404 가 된다.
    const html = await Bun.file(join(out, 'index.html')).text();
    expect(html).toMatch(/(href|src)="\//);
  });
});
