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
    // 초기 목록을 받은 뒤에야 URL 의 번호를 todo id 로 해석할 수 있다.
    void refetch().then(() =>
      useUiStore.getState().applyRoute(parseRoute(window.location.pathname)),
    );
    // 출처는 화면 수명 동안 바뀌지 않으니 부팅에 한 번만 확인한다 (refetch 에 얹으면
    // SSE 이벤트마다 health 를 다시 묻게 된다).
    void useUiStore.getState().loadCapabilities();

    const onPopState = () => {
      void useUiStore.getState().applyRoute(parseRoute(window.location.pathname));
    };
    window.addEventListener('popstate', onPopState);

    // 모바일 브라우저는 탭이 백그라운드로 가면 EventSource 와 타이머를 얼린다. 돌아와도
    // 끊겨 있던 동안의 변경은 오지 않으므로, SSE 재연결을 기다리지 않고 즉시 다시 읽는다.
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        // LAN 밖에서 포그라운드로 돌아오는 게 가장 흔한 실패 경로 — refetch 가 reject 하면
        // 처리되지 않은 rejection 으로 남고 사용자에게는 아무 신호도 없다. 연결 배지를
        // 내려서 현실(끊김)을 보여주고, 이후 SSE 재연결이 다시 올려준다.
        void refetch().catch(() => setConnected(false));
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    const source = new EventSource('/api/events');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = () => {
      // 연속 mutation 을 한 번의 refetch 로 흡수
      clearTimeout(debounce.current);
      debounce.current = setTimeout(() => void refetch(), 150);
    };
    // doing 경과 표시 갱신용 주기 리렌더
    const tick = setInterval(() => void refetch(), 60_000);
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
      <div className="layout">
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
