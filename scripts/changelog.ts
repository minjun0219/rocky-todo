/**
 * CHANGELOG.md 텍스트에서 특정 버전 섹션의 본문만 추출한다 (릴리스 노트용).
 * changesets 가 쓰는 형식(`## <version>` 헤딩 + 다음 `## ` 헤딩 전까지)을 가정한다.
 * 매칭되는 섹션이 없으면 빈 문자열을 반환한다.
 */
export function extractChangelogSection(changelog: string, version: string): string {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start === -1) {
    return '';
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
}
