"use client";

import { useEffect, useState } from "react";
import { apiText } from "@/lib/api";
import { Failure, Loading, PageHeader, StatusBadge } from "@/components/Shell";

type HealthState = { health: string; readiness: string; metrics: string };

export default function HealthPage() {
  const [state, setState] = useState<HealthState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([apiText("/health"), apiText("/ready"), apiText("/metrics")])
      .then(([health, readiness, metrics]) => setState({ health, readiness, metrics }))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load health status"));
  }, []);
  return <><PageHeader eyebrow="Operations / health" title="System health" detail="Live service checks from the backend." />{error && <Failure message={error} />}{!state && !error ? <Loading /> : state && <div className="grid content-grid"><section className="panel"><h3 className="panel-title">Services</h3><div className="feed-item"><strong>API</strong><StatusBadge status={state.health.includes('ok') ? "ONLINE" : "OFFLINE"} /><span>{state.health}</span></div><div className="feed-item"><strong>Readiness</strong><StatusBadge status={state.readiness.includes('ok') ? "ONLINE" : "OFFLINE"} /><span>{state.readiness}</span></div></section><section className="panel"><h3 className="panel-title">Metrics endpoint</h3><pre className="mono" style={{ whiteSpace: "pre-wrap", color: "var(--cyan)" }}>{state.metrics}</pre></section></div>}</>;
}
