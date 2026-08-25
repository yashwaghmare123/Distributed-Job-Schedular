"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  BarChart3,
  Boxes,
  BriefcaseBusiness,
  ChevronLeft,
  ClipboardList,
  HeartPulse,
  LayoutDashboard,
  LogOut,
  Radio,
  Settings2,
  Users,
} from "lucide-react";
import { apiClient, setAccessToken } from "@/lib/api";
import { useEffect, useState } from "react";
import { connectSocket, disconnectSocket, subscribeSocket, subscribeSocketStatus, isSocketConnected, type SocketStatus } from "@/lib/socket";
import { useSelectedProject } from "@/lib/projectContext";

const globalLinks = [["/projects", "Projects", BriefcaseBusiness]] as const;

const projectLinks = [
  ["/dashboard", "Overview", LayoutDashboard],
  ["/queues", "Queues", Boxes],
  ["/jobs", "Jobs", ClipboardList],
  ["/scheduled", "Scheduled", Radio],
  ["/workers", "Workers", Users],
  ["/executions", "Executions", Activity],
  ["/dlq", "Dead Letter", Boxes],
  ["/metrics", "Metrics", BarChart3],
  ["/health", "Health", HeartPulse],
] as const;

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [online, setOnline] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { selectedProject, selectedProjectId, setSelectedProjectId, loading } = useSelectedProject();
  const isProjectsPage = pathname === "/projects";
  const isProjectEntry = pathname.startsWith("/project/");
  const isControlPlane = !isProjectsPage && (isProjectEntry || Boolean(selectedProject));

  useEffect(() => {
    let active = true;
    void (apiClient.session?.() ?? Promise.reject(new Error("Authentication required."))).catch(() => { if (active) router.replace("/login"); });
    if (loading) return;
    if (!isProjectsPage && !selectedProject && !isProjectEntry) {
      router.replace("/projects");
      return;
    }
    connectSocket();
    const unsubscribe = subscribeSocket(() => setOnline(isSocketConnected()));
    const timer = window.setInterval(() => setOnline(isSocketConnected()), 500);
    return () => {
      active = false;
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [isProjectEntry, isProjectsPage, router, selectedProject]);

  const logout = () => {
    void (apiClient.logout?.() ?? Promise.resolve()).catch(() => undefined);
    disconnectSocket();
    setAccessToken(null);
    setSelectedProjectId(null);
    router.replace("/login");
  };

  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand-wrap">
          <div className="brand-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2L2 7L2 17L12 22L22 17L22 7L12 2Z" />
            </svg>
          </div>
          <div className="brand-text">
            <div className="brand-mark">Control plane</div>
            <h1>Scheduler Ops</h1>
          </div>
        </div>

        {isControlPlane && selectedProject && (
          <div className="project-card-mini">
            <span className="eyebrow">Current project</span>
            <strong>{selectedProject.name}</strong>
          </div>
        )}

        <div className="nav-sections">
          <div className="nav-section">
            <span className="nav-label">Control Plane</span>
            <nav className="nav">
              {(isControlPlane ? projectLinks : globalLinks).map(([href, label, Icon]) => {
                const projectHref = selectedProjectId ? `/project/${selectedProjectId}${href === "/dashboard" ? "/overview" : href}` : href;
                const isActive = pathname === projectHref || pathname.startsWith(`${projectHref}/`);
                return (
                  <Link key={href} href={projectHref} className={`nav-item ${isActive ? "active" : ""}`} title={sidebarCollapsed ? label : undefined}>
                    <Icon size={18} />
                    <span>{label}</span>
                  </Link>
                );
              })}
            </nav>
          </div>

          {isControlPlane && (
            <div className="nav-section">
              <span className="nav-label">Admin</span>
              <nav className="nav">
                <Link href="/projects" className={`nav-item ${pathname === "/projects" ? "active" : ""}`} title={sidebarCollapsed ? "Projects" : undefined}>
                  <BriefcaseBusiness size={18} />
                  <span>Projects</span>
                </Link>
                <Link href="/settings" className={`nav-item ${pathname === "/settings" ? "active" : ""}`} title={sidebarCollapsed ? "Settings" : undefined}>
                  <Settings2 size={18} />
                  <span>Settings</span>
                </Link>
              </nav>
            </div>
          )}
        </div>

        <div className="sidebar-footer">
          <button 
            type="button" 
            className="collapse-button" 
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? "Expand" : "Collapse"}
          >
            <ChevronLeft size={18} />
          </button>
          <button type="button" className="nav-item button-link" onClick={logout} title={sidebarCollapsed ? "Sign out" : undefined}>
            <LogOut size={18} />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      <main className={`page-shell ${online ? "live" : ""}`}>
        <div className="page-content">{children}</div>
      </main>
    </div>
  );
}

export function PageHeader({ eyebrow, title, detail, backHref, children }: { eyebrow: string; title: string; detail?: string; backHref?: string; children?: React.ReactNode }) {
  const router = useRouter();
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("DISCONNECTED");
  useEffect(() => {
    const unsubscribe = subscribeSocketStatus(setSocketStatus);
    return () => {
      unsubscribe();
    };
  }, []);
  const statusLabel = socketStatus === "CONNECTED" ? "Connected" : socketStatus === "RECONNECTING" ? "Reconnecting" : "Disconnected";

  return (
    <header className="topbar">
      <div className="page-title-wrap">
        <div className="page-header-top">
          {backHref && (
            <button
              className="back-button"
              onClick={() => router.push(backHref)}
              title="Go back"
            >
              ← Back
            </button>
          )}
          <div className="eyebrow">{eyebrow}</div>
        </div>
        <h2>{title}</h2>
        {detail && <p className="subtle">{detail}</p>}
      </div>
      <div className="topbar-actions">
        {children}
        <span className="status-pill">
          <span className={`status-dot ${socketStatus === "CONNECTED" ? "live" : ""}`} />
          <Radio size={13} />
          {statusLabel}
        </span>
      </div>
    </header>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{status.replace("_", " ")}</span>;
}
export function Loading() { return <div className="panel empty">Loading operational data...</div>; }
export function Failure({ message }: { message: string }) { return <div className="error">{message}</div>; }
