---
'@minjun0219/rocky-todo': minor
---

Tailwind v4 토대를 깐다 — 시각 무변경

`bun-plugin-tailwind` 를 `[serve.static]` 에 걸어 데몬이 서빙 시점에 CSS 를 Tailwind 로
처리한다. 빌드 스텝은 여전히 없다. preflight 는 들이지 않고(theme + utilities 레이어만)
`@theme inline` 으로 기존 의미 토큰(`--warm`/`--cool`/…)을 유틸리티에 다리 놓는다 —
`text-warm` 처럼 의미 이름 그대로 쓰고, `text-amber-400` 류 원색 팔레트는 비활성.

bunfig.toml 은 시작 시점 cwd 에서 읽히므로 spawn 쪽(cli/hook 의 `ensureDaemon`, launchd
plist)이 cwd 를 레포 루트로 고정한다. 수제 keyframes 는 `rt-pulse` 로 네임스페이스 —
Tailwind 스캐너가 bare `pulse` 를 클래스 후보로 오인해 자기 keyframes 를 싣는 충돌을
원천 차단한다.

기존 화면은 그대로다 — computed 스타일 스팟 체크로 확인. 파티션별 유틸리티 이관은
후속 PR 에서 파일 단위로 간다.
