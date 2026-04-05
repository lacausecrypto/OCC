import { useMonitorStore } from "../stores/monitor";

/**
 * Hook that manages SSE connection lifecycle.
 * Executions are tracked via SSE events only — no REST polling.
 */
export function useSSE() {
  const { connect, disconnect, sseStatus } = useMonitorStore();

  const connectSSE = () => {
    connect("/events");
  };

  const disconnectSSE = () => {
    disconnect();
  };

  return { sseStatus, connectSSE, disconnectSSE };
}
