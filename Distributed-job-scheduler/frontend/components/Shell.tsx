"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Activity, Boxes, BriefcaseBusiness, ClipboardList, KeyRound, LayoutDashboard, LogOut, Radio, Settings2, Users } from "lucide-react";
import { setAccessToken } from "@/lib/api";
import { useEffect, useState } from "react";
import { connectSocket, disconnectSocket, subscribeSocket, subscribeSocketStatus, isSocketConnected, type SocketStatus } from "@/lib/socket";

const links = [
  ["/dashboard", "Overview", LayoutDashboard], ["/projects", "Projects", BriefcaseBusiness], ["/queues", "Queues", Boxes], ["/jobs", "Jobs", ClipboardList], ["/workers", "Workers", Users], ["/executions", "Executions", Activity], ["/scheduled", "Scheduled", Radio], ["/dlq", "Dead letter", Boxes], ["/metrics", "Metrics", Activity], ["/health", "Health", Activity], ["/api-keys", "API keys", KeyRound]
] as const;

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname(); const router = useRouter(); const [online, setOnline] = useState(false);
  useEffect(() => { if (!sessionStorage.getItem("scheduler.access")) router.replace("/login"); connectSocket(); const unsubscribe = subscribeSocket(() => setOnline(isSocketConnected())); const timer = window.setInterval(() => setOnline(isSocketConnected()), 500); return () => { unsubscribe(); window.clearInterval(timer); }; }, [router]);
  const logout = () => { disconnectSocket(); setAccessToken(null); sessionStorage.removeItem("scheduler.refresh"); router.replace("/login"); };
  return <div className="shell"><aside className="sidebar"><div className="brand"><div className="brand-mark">Control plane / 16</div><h1>Scheduler<br />Ops</h1></div><nav className="nav">{links.map(([href, label, Icon]) => <Link key={href} href={href} className={pathname.startsWith(href) ? "active" : ""}><Icon size={16} />{label}</Link>)}</nav><div style={{ marginTop: "auto", paddingTop: 30 }}><Link href="/settings"><Settings2 size={16} />Settings</Link><button className="nav" style={{ width: "100%", background: "none", border: 0, color: "var(--muted)", textAlign: "left" }} onClick={logout}><span style={{ display: "flex", gap: 11, alignItems: "center", padding: "10px 12px" }}><LogOut size={16} />Sign out</span></button></div></aside><main className={`main ${online ? "live" : ""}`}>{children}</main></div>;
}

export function PageHeader({ eyebrow, title, detail, children }: { eyebrow: string; title: string; detail?: string; children?: React.ReactNode }) { const [socketStatus, setSocketStatus] = useState<SocketStatus>("DISCONNECTED"); useEffect(() => { const unsubscribe = subscribeSocketStatus(setSocketStatus); return () => { unsubscribe(); }; }, []); const statusLabel = socketStatus === "CONNECTED" ? "Connected" : socketStatus === "RECONNECTING" ? "Reconnecting" : "Disconnected"; return <header className="topbar"><div><div className="kicker">{eyebrow}</div><h2>{title}</h2>{detail && <p className="subtle">{detail}</p>}</div><div style={{ display: "grid", justifyItems: "end", gap: 12 }}>{children}<span className="status-pill"><span className={`status-dot ${socketStatus === "CONNECTED" ? "live" : ""}`} /><Radio size={13} /> {statusLabel}</span></div></header>; }

export function StatusBadge({ status }: { status: string }) { return <span className={`badge ${status}`}>{status.replace("_", " ")}</span>; }
export function Loading() { return <div className="panel empty">Loading operational data...</div>; }
export function Failure({ message }: { message: string }) { return <div className="error">{message}</div>; }
