"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, BarChart3, Clock3, Gauge, RefreshCw, Server, Timer } from "lucide-react";
import { apiClient, apiText } from "@/lib/api";
import { subscribeSocket } from "@/lib/socket";
import type { ExecutionRow, Job, ScheduledJob, Worker } from "@/lib/types";

type MetricData = { executions: ExecutionRow[]; scheduled: ScheduledJob[]; dlqCount: number; text: string };

function prometheusValue(text: string, name: string) {
  const match = text.match(new RegExp(`^${name}\\s+([0-9.]+)$`, "m"));
  return match ? Number(match[1]) : null;
}

function BarChart({ values, colors = ["var(--cyan)"] }: { values: Array<{ label: string; value: number }>; colors?: string[] }) {
  const maximum = Math.max(...values.map((item) => item.value), 1);
  return <div style={{ display: "grid", gap: 12 }}>{values.map((item, index) => <div key={`${item.label}-${index}`} style={{ display: "grid", gridTemplateColumns: "86px minmax(0, 1fr) 42px", gap: 9, alignItems: "center", font: "12px ui-monospace, SFMono-Regular, Menlo, monospace" }}><span>{item.label}</span><div style={{ height: 9, background: "var(--ink)", border: "1px solid var(--line)" }}><i style={{ display: "block", height: "100%", width: `${item.value ? Math.max((item.value / maximum) * 100, 4) : 0}%`, background: colors[index % colors.length] }} /></div><b style={{ textAlign: "right" }}>{item.value.toLocaleString()}</b></div>)}</div>;
}

function LineChart({ values }: { values: number[] }) {
  if (!values.length) return <div className="empty">No completed timestamps available.</div>;
  const maximum = Math.max(...values, 1);
  const points = values.map((value, index) => `${(index / Math.max(values.length - 1, 1)) * 100},${100 - (value / maximum) * 84 - 8}`).join(" ");
  return <svg style={{ display: "block", width: "100%", height: 150, background: "linear-gradient(to bottom, transparent 24%, var(--line) 25%, transparent 26%, transparent 49%, var(--line) 50%, transparent 51%, transparent 74%, var(--line) 75%, transparent 76%)" }} viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Jobs processed over time"><polyline points={points} fill="none" stroke="var(--cyan)" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>;
}

function Panel({ title, icon, children, detail }: { title: string; icon: React.ReactNode; children: React.ReactNode; detail?: string }) {
  return <section className="panel"><div className="panel-head"><h3 className="panel-title">{title}</h3>{icon}</div>{children}{detail && <p className="subtle" style={{ marginBottom: 0, lineHeight: 1.5 }}>{detail}</p>}</section>;
}

export function OverviewMetrics({ jobs, workers, events }: { jobs: Job[]; workers: Worker[]; events: number }) {
  const [data, setData] = useState<MetricData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const load = async () => {
    try {
      const [executions, scheduled, dlq, text] = await Promise.all([apiClient.allExecutions(), apiClient.allScheduledJobs(), apiClient.dlq(), apiText("/metrics")]);
      setData({ executions, scheduled, dlqCount: dlq.data.length, text });
      setError(null);
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to load overview metrics"); }
  };
  useEffect(() => { void load(); const unsubscribe = subscribeSocket((event) => { if (event.type === "worker.heartbeat") return; if (refreshTimerRef.current !== null) return; refreshTimerRef.current = window.setTimeout(() => { refreshTimerRef.current = null; void load(); }, 10000); }); return () => { unsubscribe(); if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current); }; }, []);
  if (error && !data) return <div className="error">{error}</div>;
  if (!data) return <div className="panel empty">Loading live metrics...</div>;
  const completed = jobs.filter((job) => job.status === "COMPLETED").length;
  const failed = jobs.filter((job) => job.status === "FAILED").length;
  const queueDepth = prometheusValue(data.text, "queue_depth");
  const retryCount = prometheusValue(data.text, "jobs_retried_total");
  const processed = jobs.filter((job) => job.completedAt).sort((a, b) => new Date(a.completedAt!).getTime() - new Date(b.completedAt!).getTime()).map((_, index) => index + 1);
  const durations = data.executions.filter((execution) => execution.durationMs !== null && execution.durationMs !== undefined).slice(-8);
  const utilization = workers.map((worker) => ({ label: worker.name, value: worker.concurrency ? Math.round((worker.currentJobCount / worker.concurrency) * 100) : 0 }));
  return <>
    {error && <div className="error">{error}</div>}
    <div className="grid content-grid" style={{ marginTop: 14 }}>
      <Panel title="Jobs processed over time" icon={<Activity size={18} color="var(--cyan)" />} detail="Cumulative completed jobs from real completedAt timestamps."><LineChart values={processed} /></Panel>
      <Panel title="Completed vs failed" icon={<BarChart3 size={18} color="var(--cyan)" />}><BarChart values={[{ label: "Completed", value: completed }, { label: "Failed", value: failed }]} colors={["var(--cyan)", "var(--red)"]} /></Panel>
      <Panel title="Queue depth" icon={<Gauge size={18} color="var(--amber)" />} detail="Current backend gauge. Historical queue depth is not exposed."><strong style={{ display: "block", fontSize: 42, color: "var(--amber)", marginBottom: 8 }}>{queueDepth === null ? "Unavailable" : queueDepth.toLocaleString()}</strong><span className="subtle">queued, claimed, running, retrying, or scheduled</span></Panel>
      <Panel title="Execution duration" icon={<Timer size={18} color="var(--blue)" />}><BarChart values={durations.map((execution) => ({ label: `Attempt ${execution.attemptNumber}`, value: execution.durationMs ?? 0 }))} colors={["var(--blue)"]} /></Panel>
      <Panel title="Worker utilization" icon={<Server size={18} color="var(--cyan)" />} detail="Current jobs divided by declared worker concurrency."><BarChart values={utilization} /></Panel>
      <Panel title="Retry count" icon={<RefreshCw size={18} color="var(--amber)" />} detail="Backend jobs_retried_total counter."><strong style={{ display: "block", fontSize: 42, color: "var(--amber)", marginBottom: 8 }}>{retryCount === null ? "Unavailable" : retryCount.toLocaleString()}</strong><span className="subtle">real retry events</span></Panel>
      <Panel title="DLQ count" icon={<Clock3 size={18} color="var(--red)" />} detail="Current authenticated DLQ records."><strong style={{ display: "block", fontSize: 42, color: "var(--red)", marginBottom: 8 }}>{data.dlqCount.toLocaleString()}</strong><span className="subtle">dead-letter records</span></Panel>
      <Panel title="Scheduled jobs" icon={<Activity size={18} color="var(--amber)" />}><BarChart values={[{ label: "Enabled", value: data.scheduled.filter((job) => job.enabled).length }, { label: "Disabled", value: data.scheduled.filter((job) => !job.enabled).length }]} colors={["var(--amber)", "var(--muted)"]} /></Panel>
    </div>
    <p className="subtle" style={{ textAlign: "right", marginTop: 12 }}>{events ? `Live event stream active · ${events} recent events` : "Waiting for real WebSocket events"}</p>
  </>;
}
