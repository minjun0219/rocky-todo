#!/usr/bin/env bun
/**
 * package.json 의 version 을 읽어 나머지 버전 파일에 반영한다 —
 * `.claude-plugin/plugin.json` / `Cargo.toml`(workspace.package) / `Cargo.lock`(멤버 항목).
 * changesets 는 package.json 만 범프하므로, 네 버전 파일을 lockstep 으로 유지하기 위한
 * 후처리 스크립트(`bun run changeset:version` 의 뒷단). 치환 규칙은 `./sync-version`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncCargoLock, syncCargoToml, syncPluginJson } from './sync-version';

const repoRoot = join(import.meta.dir, '..');
const pkgPath = join(repoRoot, 'package.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
const version = pkg.version;
if (!version) {
  throw new Error(`package.json 에 version 이 없다: ${pkgPath}`);
}

const targets: Array<[string, (text: string, version: string) => string]> = [
  [join('.claude-plugin', 'plugin.json'), syncPluginJson],
  ['Cargo.toml', syncCargoToml],
  ['Cargo.lock', syncCargoLock],
];

for (const [relative, sync] of targets) {
  const path = join(repoRoot, relative);
  const text = readFileSync(path, 'utf8');
  const next = sync(text, version);
  if (next !== text) {
    writeFileSync(path, next);
    console.log(`${relative} version → ${version}`);
  } else {
    console.log(`${relative} version 이미 ${version} (변경 없음)`);
  }
}
