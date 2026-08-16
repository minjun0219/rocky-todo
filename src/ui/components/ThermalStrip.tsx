import { useEffect, useState } from 'react';
import { actorTone, formatElapsed } from '../lib';
import { useUiStore } from '../store';

interface HistoryEvent {
  id: number;
  actor: string;
  at: string;
}

const LIMIT = 48;

/**
 * 온도 띠 — 최근 활동을 시간순(왼쪽=과거)으로 늘어놓은 눈금.
 * 눈금 하나 = 히스토리 이벤트 하나, 색은 두 대기 그대로(warm=에이전트, cool=사람),
 * 과거로 갈수록 식는다(투명해진다). 보드가 지금 얼마나 뜨거운지, 누가 데우고
 * 있는지를 한 눈에 준다. 스타일은 Tailwind 유틸리티 + 토큰 var — 전용 CSS 없음.
 */
export function ThermalStrip() {
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  // todos 참조가 바뀔 때마다(= SSE 가 뭔가를 갱신할 때마다) 다시 읽는다.
  const todos = useUiStore((s) => s.todos);

  // biome-ignore lint/correctness/useExhaustiveDependencies(todos): todos 는 값이 아니라 재조회 트리거다 — SSE 가 뭔가를 갱신하면 참조가 바뀐다.
  useEffect(() => {
    let alive = true;
    fetch(`/api/history?limit=${LIMIT}`)
      .then((res) => (res.ok ? (res.json() as Promise<HistoryEvent[]>) : null))
      .then((rows) => {
        // 실패(HTTP 에러 포함)는 상태를 건드리지 않는다 — 장식이 순간적으로
        // 사라졌다 나타나는 것보다 마지막 성공 스냅샷이 낫다.
        if (alive && rows) {
          setEvents([...rows].reverse()); // 최신순으로 오므로 뒤집어 왼쪽=과거
        }
      })
      .catch(() => {}); // 네트워크 에러도 같은 원칙 — 침묵
    return () => {
      alive = false;
    };
  }, [todos]);

  if (events.length === 0) {
    return null;
  }
  return (
    <div
      className="flex h-3 items-stretch gap-px overflow-hidden max-[560px]:hidden"
      role="img"
      aria-label={`최근 활동 ${events.length}건 — 앰버는 에이전트, 블루는 사람`}
    >
      {events.map((e, i) => (
        <span
          key={e.id}
          title={`${e.actor} · ${formatElapsed(e.at)}`}
          className="w-[3px] rounded-[1px]"
          style={{
            background: `var(--${actorTone(e.actor)})`,
            // 식는 곡선 — 최신(오른쪽)이 1, 과거로 갈수록 0.15 까지.
            opacity: 0.15 + 0.85 * (i / Math.max(1, events.length - 1)),
          }}
        />
      ))}
    </div>
  );
}
