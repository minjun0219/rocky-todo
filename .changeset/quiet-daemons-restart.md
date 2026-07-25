---
"@minjun0219/rocky-todo": patch
---

데몬을 버전 인식으로 재기동하고, 깨져 있던 CLI 진입점을 고쳤다.

- `SessionStart` 훅이 health 유무만 보고 no-op 하던 탓에, 플러그인을 업데이트해도 캐시의
  구버전 디렉터리에서 돌던 데몬이 계속 자리를 지켜 새 코드가 뜨지 않았다. 이제 `/api/health`
  가 `version`/`pid` 를 보고하고, 훅이 자기 버전과 다르면 SIGTERM 으로 내린 뒤 재기동한다.
  종료에 실패하면 재기동하지 않는다 (fail-open — 구버전이라도 보드를 살려 둔다).
  - launchd(KeepAlive) 로 상주 등록된 경우 PID 만 죽이면 launchd 가 같은 구버전을 즉시
    되살리므로, 훅이 상주 job 을 현재 설치 경로로 교체(bootout→plist 갱신→bootstrap)한다.
  - health 응답은 `ok === true` + `name === 'rocky-todo'` 로 신원을 검증한다 — 포트를
    가로챈 무관한 서비스를 데몬으로 오인해 그 PID 에 SIGTERM 을 보내지 않도록.
- `bin/rocky-todo` 가 별도 레포 분리 이전 경로(`../src/todo/cli`)를 참조해 CLI 가 전혀 실행되지
  않았다. `bin/` 은 tsc(`include`)·biome 어느 쪽도 검사하지 않아 게이트를 통과했으므로, 진입점
  스모크 테스트를 추가해 회귀를 막는다.
