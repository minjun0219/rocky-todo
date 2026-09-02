/**
 * 버전 파일들을 package.json 기준으로 맞추는 순수 텍스트 치환.
 *
 * changesets 는 package.json 만 범프한다. 나머지 셋(plugin.json / Cargo.toml / Cargo.lock)은
 * `sync-plugin-version.ts` 가 이 함수들로 lockstep 을 맞춘다. 전부 **텍스트 치환**이다 —
 * 재직렬화하면 포맷이 흔들려 Version PR 의 diff 가 커지고, Cargo.lock 은 cargo 가 없는
 * ubuntu 러너(version job)에서도 고쳐야 하므로 `cargo update` 에 기댈 수 없다.
 */

/** Cargo.lock 에서 버전을 고칠 워크스페이스 멤버 — path 의존이라 lock 에는 이름+버전만 있다. */
export const WORKSPACE_MEMBERS = [
  'rocky-todo-core',
  'rocky-todod',
  'rocky-todo-cli',
  'rocky-todo-app',
] as const;

/**
 * plugin.json 의 최상위 `"version"` 만 바꾼다. 줄 시작 앵커(^…/m)로 최상위 라인만 잡고 콜론
 * 주변 공백을 허용해, 설명 문구 등에 "version" 이 먼저 나와도 오매칭되지 않는다.
 * @throws 필드를 못 찾으면
 */
export function syncPluginJson(text: string, version: string): string {
  const re = /^([ \t]*"version"[ \t]*:[ \t]*)"[^"]*"/m;
  if (!re.test(text)) {
    throw new Error('plugin.json 에서 version 필드를 찾지 못했다');
  }
  return text.replace(re, `$1"${version}"`);
}

/**
 * 워크스페이스 루트 Cargo.toml 의 `[workspace.package]` 안 `version` 만 바꾼다 — 크레이트들은
 * `version.workspace = true` 로 물려받으므로 여기 하나가 진실이다. 다른 섹션의 `version` 키
 * (의존성 표기 등)는 건드리지 않는다.
 * @throws 섹션이나 필드를 못 찾으면
 */
export function syncCargoToml(text: string, version: string): string {
  const section = /^\[workspace\.package\][^[]*/m.exec(text);
  if (!section) {
    throw new Error('Cargo.toml 에서 [workspace.package] 섹션을 찾지 못했다');
  }
  const re = /^(version[ \t]*=[ \t]*)"[^"]*"/m;
  if (!re.test(section[0])) {
    throw new Error('Cargo.toml 의 [workspace.package] 에 version 이 없다');
  }
  const patched = section[0].replace(re, `$1"${version}"`);
  return text.slice(0, section.index) + patched + text.slice(section.index + section[0].length);
}

/**
 * Cargo.lock 의 워크스페이스 멤버 `[[package]]` 항목 버전을 바꾼다. 외부 크레이트 항목은
 * 이름이 다르므로 스치지 않는다. 멤버가 하나라도 없으면 실패 — lock 이 어긋난 채 남으면
 * `--locked` 빌드가 죽고, 그 실패는 Version PR 이 아니라 릴리스 빌드에서야 드러난다.
 * @throws 멤버 항목을 못 찾으면
 */
export function syncCargoLock(text: string, version: string): string {
  let next = text;
  for (const name of WORKSPACE_MEMBERS) {
    const re = new RegExp(`^(name = "${name}"\\nversion = )"[^"]*"`, 'm');
    if (!re.test(next)) {
      throw new Error(`Cargo.lock 에 ${name} 항목이 없다`);
    }
    next = next.replace(re, `$1"${version}"`);
  }
  return next;
}
