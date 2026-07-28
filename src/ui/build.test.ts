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

  test('Tailwind 가 preflight 없이 연결된다', async () => {
    const css = await bundledCss(out);
    // preflight(요소 리셋)가 들어오면 수제 리셋과 겹쳐 화면이 바뀐다 — 시각 동결 위반.
    // theme/utilities 레이어만 임포트하므로 요소 셀렉터 리셋이 없어야 한다.
    expect(css).not.toMatch(/^\s*(html|body|button)\s*[,{]/m);
    // 팔레트 토큰 블록은 그대로 살아 있어야 한다 (styles.test.ts 의 대비 가드가 소스를,
    // 이 테스트가 번들 산출물을 지킨다).
    expect(css).toContain('#16110c');
    expect(css).toContain('#faf6f0');
    // 파이프라인이 실제로 붙었다는 근거 — Tailwind theme 레이어의 시그니처 변수.
    expect(css).toContain('--tw-');
  });
});

async function bundledCss(outdir: string): Promise<string> {
  const cssFile = readdirSync(outdir).find((f) => f.endsWith('.css'));
  if (!cssFile) {
    throw new Error('css chunk not found');
  }
  return Bun.file(join(outdir, cssFile)).text();
}
