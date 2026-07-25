#!/usr/bin/env bun
/**
 * package.json 의 version 을 읽어 .claude-plugin/plugin.json 의 version 에 반영한다.
 * changesets 는 package.json 만 범프하므로, 두 버전 파일을 lockstep 으로 유지하기 위한 후처리 스크립트.
 * plugin.json 은 텍스트로 읽어 최상위 "version" 필드만 정규식으로 치환한다 (전체 재직렬화/재포맷 없이 최소 diff).
 * 줄 시작 앵커(^…/m)로 최상위 라인만 잡고 콜론 주변 공백을 허용해, 설명 문구 등에 "version" 이 먼저 나와도 오매칭되지 않는다.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..');
const pkgPath = join(repoRoot, 'package.json');
const pluginPath = join(repoRoot, '.claude-plugin', 'plugin.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
const version = pkg.version;
if (!version) {
  throw new Error(`package.json 에 version 이 없다: ${pkgPath}`);
}

const pluginText = readFileSync(pluginPath, 'utf8');
const versionRe = /^([ \t]*"version"[ \t]*:[ \t]*)"[^"]*"/m;
if (!versionRe.test(pluginText)) {
  throw new Error(`plugin.json 에서 version 필드를 찾지 못했다: ${pluginPath}`);
}
const next = pluginText.replace(versionRe, `$1"${version}"`);

if (next !== pluginText) {
  writeFileSync(pluginPath, next);
  console.log(`plugin.json version → ${version}`);
} else {
  console.log(`plugin.json version 이미 ${version} (변경 없음)`);
}
