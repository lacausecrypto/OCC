import { useEffect, useRef } from "react";
import { useServerStore } from "./stores/server";
import { useMonitorStore } from "./stores/monitor";
import { useDesignStore } from "./stores/design";
import { AppLayout } from "./components/layout";

function App() {
  const { checkHealth, serverOnline } = useServerStore();
  const sseStatus = useMonitorStore((s) => s.sseStatus);
  const applyBlend = useDesignStore((s) => s.applyBlend);
  const bootedRef = useRef(false);

  // Poll server health every 10s
  useEffect(() => {
    void checkHealth();
    const interval = setInterval(() => void checkHealth(), 10000);
    return () => clearInterval(interval);
  }, [checkHealth]);

  // Auto-connect SSE when server comes online (once)
  useEffect(() => {
    if (serverOnline && sseStatus === "disconnected" && !bootedRef.current) {
      bootedRef.current = true;
      // Small delay to let things settle
      const timer = setTimeout(() => {
        useMonitorStore.getState().connect("/events");
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [serverOnline, sseStatus]);

  // Apply initial design blend on mount
  useEffect(() => {
    applyBlend();
  }, [applyBlend]);

  return <AppLayout />;
}

export default App;
