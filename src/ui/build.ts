import { join } from 'node:path';
import tailwind from 'bun-plugin-tailwind';

/**
 * 웹 UI 를 outdir 로 번들한다 — 데몬이 시작할 때 한 번 부른다.
 *
 * 런타임 HTML import(`routes: { '/': ui }`) 대신 명시적 Bun.build 를 쓰는 이유:
 * bun-plugin-tailwind 의 클래스 스캔이 `[serve.static]` 플러그인 경로에서는 동작하지
 * 않는다(유틸리티 0개 생성 — Bun 1.3.14 + plugin 0.0.15 실측, development true/false
 * 모두). Bun.build 에 plugins 를 직접 넘기면 전부 동작한다. Tailwind 플러그인은
 * 다음 단계에서 여기에 더해진다.
 */
export async function buildUi(outdir: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, 'index.html')],
    outdir,
    plugins: [tailwind],
    minify: true,
    // 자산 참조를 루트 절대 경로로 — 퍼머링크(`/rocky/12`) 새로고침에서도 청크가 로드된다.
    publicPath: '/',
  });
  if (!result.success) {
    throw new AggregateError(result.logs, 'UI bundle failed');
  }
}
