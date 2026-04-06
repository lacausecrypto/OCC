import { useState, useCallback, useEffect, useRef, lazy, Suspense } from "react";
import styles from "./AppLayout.module.css";
import { CollapseButton } from "./CollapseButton";
import { MainTabs } from "./MainTabs";
import { DesignSidebar } from "../sidebar";
import { MonitorSidebar } from "../monitor";
import { ErrorBoundary } from "../ErrorBoundary";
import { useAppStore } from "../../stores/app";
import { useShortcutStore } from "../../stores/shortcuts";

const Dashboard = lazy(() => import("../dashboard/Dashboard").then((m) => ({ default: m.Dashboard })));
const CanvasEditor = lazy(() => import("../canvas/CanvasEditor").then((m) => ({ default: m.CanvasEditor })));
const BlobCanvas = lazy(() => import("../blob/BlobCanvas").then((m) => ({ default: m.BlobCanvas })));
const Settings = lazy(() => import("../settings/Settings").then((m) => ({ default: m.Settings })));

export function AppLayout() {
  const appRef = useRef<HTMLDivElement>(null);

  const [leftCollapsed, setLeftCollapsed] = useState(true);
  const [rightCollapsed, setRightCollapsed] = useState(true);

  const activeTab = useAppStore((s) => s.activeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);

  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => {
      const mobile = window.innerWidth < 1024;
      setIsMobile(mobile);
      if (mobile) { setLeftCollapsed(true); setRightCollapsed(true); }
    };
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  const toggleLeft = useCallback(() => setLeftCollapsed((v) => !v), []);
  const toggleRight = useCallback(() => setRightCollapsed((v) => !v), []);
  const closeMobileOverlay = useCallback(() => { setLeftCollapsed(true); setRightCollapsed(true); }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement)?.tagName)) return;
      const { matches } = useShortcutStore.getState();
      if (matches(e, "nav.dashboard")) setActiveTab("dashboard");
      if (matches(e, "nav.workflow")) setActiveTab("canvas");
      if (matches(e, "nav.blob")) setActiveTab("blob");
      if (matches(e, "nav.settings")) setActiveTab("settings");
      if (matches(e, "nav.toggleDesign")) setLeftCollapsed((v) => !v);
      if (matches(e, "nav.toggleMonitor")) setRightCollapsed((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setActiveTab]);

  const appClassName = [
    styles.app,
    leftCollapsed ? styles.leftCollapsed : "",
    rightCollapsed ? styles.rightCollapsed : "",
  ].filter(Boolean).join(" ");

  const showOverlay = isMobile && (!leftCollapsed || !rightCollapsed);

  return (
    <div ref={appRef} className={appClassName}>
      {/* Left sidebar */}
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <div className={styles.logo}>
            <span className={styles.logoGradient}>OCC Chimera</span>
          </div>
          <div className={styles.logoSub}>Design Space</div>
        </div>
        <DesignSidebar />
      </div>

      {/* Center: tabs + content */}
      <div className={styles.content}>
        <MainTabs activeTab={activeTab} onTabChange={setActiveTab} />

        <div className={`${styles.tabContent} ${activeTab === "dashboard" ? styles.tabContentActive : ""}`}>
          <ErrorBoundary>
            <Suspense fallback={<div style={{ padding: 40, textAlign: "center", color: "var(--m-text2)" }}>Loading...</div>}>
              <Dashboard />
            </Suspense>
          </ErrorBoundary>
        </div>

        <div className={`${styles.tabContent} ${activeTab === "canvas" ? styles.tabContentActive : ""}`}>
          <ErrorBoundary>
            <Suspense fallback={<div style={{ padding: 40, textAlign: "center", color: "var(--m-text2)" }}>Loading...</div>}>
              <CanvasEditor />
            </Suspense>
          </ErrorBoundary>
        </div>

        <div className={`${styles.tabContent} ${activeTab === "blob" ? styles.tabContentActive : ""}`}>
          <ErrorBoundary>
            <Suspense fallback={<div style={{ padding: 40, textAlign: "center", color: "var(--m-text2)" }}>Loading...</div>}>
              <BlobCanvas />
            </Suspense>
          </ErrorBoundary>
        </div>

        <div className={`${styles.tabContent} ${activeTab === "settings" ? styles.tabContentActive : ""}`}>
          <ErrorBoundary>
            <Suspense fallback={<div style={{ padding: 40, textAlign: "center", color: "var(--m-text2)" }}>Loading...</div>}>
              <Settings />
            </Suspense>
          </ErrorBoundary>
        </div>

        {/* Collapse buttons — positioned inside content */}
        <CollapseButton side="left" collapsed={leftCollapsed} onClick={toggleLeft} title="Toggle Design Space" />
        <CollapseButton side="right" collapsed={rightCollapsed} onClick={toggleRight} title="Toggle Live Monitor" />
      </div>

      {/* Right sidebar */}
      <div className={styles.monitorSidebar}>
        <MonitorSidebar />
      </div>

      {/* Mobile overlay */}
      {showOverlay && <div className={styles.mobileOverlay} onClick={closeMobileOverlay} />}
    </div>
  );
}
