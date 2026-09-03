---
"@minjun0219/rocky-todo": minor
---

플러그인 훅·CLI 가 네이티브 바이너리로 돈다 — `bin/rocky-todo` 부트스트랩이 플러그인 버전에
맞는 릴리스 tarball(CLI + 데몬 + 웹 UI)을 `~/.local/share/rocky-todo/v<version>/` 에 한 번
받아 실행한다. bun 이 더는 필요 없다. 데몬은 실행 파일 옆 `dist/` 를 서빙한다.
