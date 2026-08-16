import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { DetailDrawer } from './components/DetailDrawer';
import { NotesRail } from './components/NotesRail';
import { Sidebar } from './components/Sidebar';
import { TodoPane } from './components/TodoPane';
import { TopBar } from './components/TopBar';
import { parseRoute } from './route';
import { useUiStore } from './store';

/**
 * rocky-todo 웹 UI 루트 — 데몬의 Bun fullstack 서빙이 이 파일을 자동 번들한다.
 * SSE(/api/events) 를 구독해 어떤 경로(CLI/MCP/다른 브라우저)의 변경이든 실시간 반영.
 */
function App() {
  const refetch = useUiStore((s) => s.refetch);
  const setConnected = useUiStore((s) => s.setConnected);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    // `refetch` 는 네트워크·서버 오류로 reject 한다(`api()` 가 !res.ok 에 throw). 아래 모든
    // 호출 지점이 이 가드를 거친다 — 빠뜨리면 처리되지 않은 rejection 으로 남는다.
    //
    // **여기서 `connected` 를 내리지 않는다.** 그 배지는 SSE 링크 상태이지 REST 성패가
    // 아니다. EventSource 는 열려 있는데 재조회 한 번이 실패한 경우까지 NO LINK 로 내리면,
    // 열린 EventSource 는 `onopen` 을 다시 쏘지 않으므로 이후 SSE 메시지가 정상으로 도착해도
    // 배지가 영영 내려간 채 남는다. 진짜 링크 단절은 `source.onerror` 가 알려주고, 데이터는
    // 다음 SSE 이벤트나 60초 tick 이 따라잡는다.
    //
    // 다만 조용히 삼키지도 않는다. 배지를 SSE 전용으로 둔 대가로, 데몬이 살아 SSE 는 흐르는데
    // REST 만 실패하는 경우 화면에는 아무 신호도 남지 않는다 — 배지는 초록인데 보드만 낡는다.
    // 그때 콘솔이 유일한 단서다.
    const onSyncError = (err: unknown): void => {
      console.warn('[rocky-todo] 보드 재조회 실패 — 화면이 낡았을 수 있다', err);
    };
    const sync = (): void => {
      void refetch().catch(onSyncError);
    };

    // 주소 해석은 목록 재조회와 실패 원인이 다르다. `applyRoute` 는 보드를 바꾸면 다시
    // refetch 하고, 번호가 풀리면 `/api/todos/:id` 로 상세를 연다 — 뒤쪽이 실패한 것을
    // "보드 재조회 실패" 라고 적으면 로그가 엉뚱한 곳을 가리킨다.
    const applyRoute = (): Promise<void> =>
      useUiStore
        .getState()
        .applyRoute(parseRoute(window.location.pathname))
        .catch((err: unknown) => {
          console.warn('[rocky-todo] 주소가 가리키는 화면을 열지 못했다', err);
        });

    // 초기 목록을 받은 뒤에야 URL 의 번호를 todo id 로 해석할 수 있다. 두 번째 인자로
    // 넘겨야 `onSyncError` 가 목록 재조회의 실패만 받는다 — `.catch()` 로 이으면 뒤따르는
    // 주소 해석의 실패까지 함께 삼킨다.
    void refetch().then(applyRoute, onSyncError);
    // 출처는 화면 수명 동안 바뀌지 않으니 부팅에 한 번만 확인한다 (refetch 에 얹으면
    // SSE 이벤트마다 health 를 다시 묻게 된다).
    void useUiStore.getState().loadCapabilities();

    const onPopState = () => {
      void applyRoute();
    };
    window.addEventListener('popstate', onPopState);

    // 모바일 브라우저는 탭이 백그라운드로 가면 EventSource 와 타이머를 얼린다. 돌아와도
    // 끊겨 있던 동안의 변경은 오지 않으므로, SSE 재연결을 기다리지 않고 즉시 다시 읽는다.
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        sync();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    const source = new EventSource('/api/events');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = () => {
      // 연속 mutation 을 한 번의 refetch 로 흡수
      clearTimeout(debounce.current);
      debounce.current = setTimeout(sync, 150);
    };
    // doing 경과 표시 갱신용 주기 리렌더
    const tick = setInterval(sync, 60_000);
    return () => {
      window.removeEventListener('popstate', onPopState);
      document.removeEventListener('visibilitychange', onVisible);
      source.close();
      clearTimeout(debounce.current);
      clearInterval(tick);
    };
  }, [refetch, setConnected]);

  return (
    <div className="app">
      <TopBar />
      <div className="layout grid min-h-0 flex-1 grid-cols-[200px_1fr_300px]">
        <Sidebar />
        <TodoPane />
        <NotesRail />
      </div>
      <DetailDrawer />
    </div>
  );
}

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(<App />);
}
