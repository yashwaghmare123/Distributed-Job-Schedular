"use client";

import { useEffect, useState } from "react";
import { apiClient, apiText } from "@/lib/api";
import { Failure, Loading, PageHeader, StatusBadge } from "@/components/Shell";
import { subscribeSocketStatus, type SocketStatus } from "@/lib/socket";

type HealthState = { health: string; readiness: string; readinessError?: string; database: string; redis: string; websocketServer: string; metrics: string };

export default function HealthPage() {
  const [state, setState] = useState<HealthState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("DISCONNECTED");
  useEffect(() => {
    const load = async () => {
      const [health, readiness, metrics] = await Promise.allSettled([apiClient.health(), apiClient.readiness(), apiText("/metrics")]);
      if (health.status === "rejected" && readiness.status === "rejected" && metrics.status === "rejected") {
        setError("Unable to load backend health status.");
        return;
      }
      setState({
        health: health.status === "fulfilled" ? health.value.status : "Unavailable",
        readiness: readiness.status === "fulfilled" ? readiness.value.status : "Unavailable",
        readinessError: readiness.status === "fulfilled" ? readiness.value.error : readiness.reason instanceof Error ? readiness.reason.message : "Unavailable",
        database: readiness.status === "fulfilled" ? readiness.value.database ?? "Not available" : "Not available",
        redis: readiness.status === "fulfilled" ? readiness.value.redis ?? "Not available" : "Not available",
        websocketServer: readiness.status === "fulfilled" ? readiness.value.websocket ?? "Not available" : "Not available",
        metrics: metrics.status === "fulfilled" ? metrics.value : "Metrics endpoint unavailable."
      });
    };
    void load();
    return subscribeSocketStatus(setSocketStatus);
  }, []);
  const backendStatus = state?.health === "ok" ? "ONLINE" : "OFFLINE";
  const readinessStatus = state?.readiness === "ok" ? "ONLINE" : "OFFLINE";
  const serviceStatus = (value: string) => value === "ready" ? "ONLINE" : "OFFLINE";
  const socketLabel = socketStatus === "CONNECTED" ? "Connected" : socketStatus === "RECONNECTING" ? "Connecting" : "Disconnected";
  return <><PageHeader eyebrow="Operations / health" title="System health" detail="Live service checks from the backend." />{error && <Failure message={error} />}{!state && !error ? <Loading /> : state && <div className="grid content-grid"><section className="panel"><h3 className="panel-title">Services</h3><div className="feed-item"><strong>API liveness</strong><StatusBadge status={backendStatus} /><span>{state.health}</span></div><div className="feed-item"><strong>Database</strong><StatusBadge status={serviceStatus(state.database)} /><span>{state.database}</span></div><div className="feed-item"><strong>Redis</strong><StatusBadge status={serviceStatus(state.redis)} /><span>{state.redis}</span></div><div className="feed-item"><strong>WebSocket server</strong><StatusBadge status={serviceStatus(state.websocketServer)} /><span>{state.websocketServer === "not_configured" ? "WebSocket hub not initialized" : state.websocketServer}</span></div><div className="feed-item"><strong>WebSocket client</strong><StatusBadge status={socketStatus === "CONNECTED" ? "ONLINE" : "OFFLINE"} /><span>{socketLabel}</span></div><div className="feed-item"><strong>Scheduler health</strong><span>Not available</span></div></section><section className="panel"><h3 className="panel-title">Global metrics endpoint</h3><p className="subtle">These process metrics are not project-scoped.</p><pre className="mono" style={{ whiteSpace: "pre-wrap", color: "var(--cyan)" }}>{state.metrics}</pre></section></div>}</>;
}
