import { useEffect, useRef } from "react";
import { useServerStore } from "./stores/server";
import { useMonitorStore } from "./stores/monitor";
import { useDesignStore } from "./stores/design";
import { useAppStore } from "./stores/app";
import { AppLayout } from "./components/layout";
import { PrerequisitesModal } from "./components/modals/PrerequisitesModal";

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

  // Listen for tab navigation from Prerequisites modal
  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent).detail;
      if (tab) useAppStore.getState().setActiveTab(tab);
    };
    window.addEventListener("occ-navigate-tab", handler);
    return () => window.removeEventListener("occ-navigate-tab", handler);
  }, []);

  return (
    <>
      <PrerequisitesModal />
      <AppLayout />
    </>
  );
}

export default App;
