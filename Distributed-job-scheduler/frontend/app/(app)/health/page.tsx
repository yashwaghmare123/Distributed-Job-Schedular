"use client";

import { useEffect, useState } from "react";
import { apiClient, apiText } from "@/lib/api";
import { Failure, Loading, PageHeader, StatusBadge } from "@/components/Shell";
import { subscribeSocketStatus, type SocketStatus } from "@/lib/socket";

type HealthState = {
  health: string;
  readiness: string;
  readinessError?: string;
  database: string;
  redis: string;
  websocketServer: string;
  metrics: string;
  workersOnline: number;
  workersTotal: number;
};

const toBadgeState = (value?: string | null) => {
  if (value === "ready" || value === "ok" || value === "ONLINE") return "ONLINE";
  if (value === "unavailable" || value === "OFFLINE" || value === "not_configured" || value === "error") return "OFFLINE";
  return "OFFLINE";
};

export default function HealthPage() {
  const [state, setState] = useState<HealthState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("DISCONNECTED");

  useEffect(() => {
    const load = async () => {
      try {
        const [health, readiness, metrics, workers] = await Promise.allSettled([
          apiClient.health(),
          apiClient.readiness(),
          apiText("/metrics"),
          apiClient.workers("?page=1&limit=100")
        ]);

        if (health.status === "rejected" && readiness.status === "rejected" && metrics.status === "rejected") {
          setError("Unable to load backend health status.");
          return;
        }

        const workerData = workers.status === "fulfilled" ? workers.value.data : [];
        setState({
          health: health.status === "fulfilled" ? health.value.status : "Unavailable",
          readiness: readiness.status === "fulfilled" ? readiness.value.status : "Unavailable",
          readinessError: readiness.status === "fulfilled" ? readiness.value.error : readiness.reason instanceof Error ? readiness.reason.message : "Unavailable",
          database: readiness.status === "fulfilled" ? readiness.value.database ?? "Not available" : "Not available",
          redis: readiness.status === "fulfilled" ? readiness.value.redis ?? "Not available" : "Not available",
          websocketServer: readiness.status === "fulfilled" ? readiness.value.websocket ?? "Not available" : "Not available",
          metrics: metrics.status === "fulfilled" ? metrics.value : "Metrics endpoint unavailable.",
          workersOnline: workerData.filter((worker) => worker.status === "ONLINE").length,
          workersTotal: workerData.length
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to load backend health status.");
      }
    };

    void load();
    return subscribeSocketStatus(setSocketStatus);
  }, []);

  const socketLabel = socketStatus === "CONNECTED" ? "Connected" : socketStatus === "RECONNECTING" ? "Connecting" : "Disconnected";

  return (
    <>
      <PageHeader eyebrow="Operations / health" title="System health" detail="Live service checks from the backend." />
      {error && <Failure message={error} />}
      {!state && !error ? <Loading /> : state && (
        <div className="grid content-grid">
          <section className="panel">
            <h3 className="panel-title">Services</h3>
            <div className="feed-item"><strong>API liveness</strong><StatusBadge status={toBadgeState(state.health)} /><span>{state.health}</span></div>
            <div className="feed-item"><strong>Readiness</strong><StatusBadge status={toBadgeState(state.readiness)} /><span>{state.readinessError || "Ready"}</span></div>
            <div className="feed-item"><strong>PostgreSQL</strong><StatusBadge status={toBadgeState(state.database)} /><span>{state.database}</span></div>
            <div className="feed-item"><strong>Redis</strong><StatusBadge status={toBadgeState(state.redis)} /><span>{state.redis}</span></div>
            <div className="feed-item"><strong>WebSocket server</strong><StatusBadge status={toBadgeState(state.websocketServer)} /><span>{state.websocketServer === "not_configured" ? "WebSocket hub not initialized" : state.websocketServer}</span></div>
            <div className="feed-item"><strong>WebSocket client</strong><StatusBadge status={socketStatus === "CONNECTED" ? "ONLINE" : "OFFLINE"} /><span>{socketLabel}</span></div>
            <div className="feed-item"><strong>Worker health</strong><StatusBadge status={state.workersTotal ? (state.workersOnline > 0 ? "ONLINE" : "OFFLINE") : "OFFLINE"} /><span>{state.workersTotal ? `${state.workersOnline} of ${state.workersTotal} workers online` : "No workers reported"}</span></div>
          </section>

          <section className="panel">
            <h3 className="panel-title">Global metrics endpoint</h3>
            <p className="subtle">These process metrics are not project-scoped.</p>
            <pre className="mono" style={{ whiteSpace: "pre-wrap", color: "var(--cyan)" }}>{state.metrics}</pre>
          </section>
        </div>
      )}
    </>
  );
}

