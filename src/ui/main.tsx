import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { DetailDrawer } from './components/DetailDrawer';
import { NotesRail } from './components/NotesRail';
import { Sidebar } from './components/Sidebar';
import { TodoPane } from './components/TodoPane';
import { TopBar } from './components/TopBar';
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
    void refetch();
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
