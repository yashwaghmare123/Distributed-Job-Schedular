"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, BarChart3, Clock3, Gauge, RefreshCw, Server, Timer } from "lucide-react";
import { apiClient, apiText } from "@/lib/api";
import { Failure, Loading, PageHeader } from "@/components/Shell";
import { subscribeSocket } from "@/lib/socket";
import { useSchedulerData } from "@/hooks/useScheduler";
import type { ExecutionRow, ScheduledJob } from "@/lib/types";

type MetricData = { executions: ExecutionRow[]; scheduled: ScheduledJob[]; dlqCount: number; text: string };

function prometheusValue(text: string, name: string) {
  const match = text.match(new RegExp(`^${name}\\s+([0-9.]+)$`, "m"));
  return match ? Number(match[1]) : null;
}

function formatNumber(value: number | null) { return value === null ? "Unavailable" : value.toLocaleString(); }

function BarChart({ values, colors = ["var(--cyan)"] }: { values: Array<{ label: string; value: number }>; colors?: string[] }) {
  const maximum = Math.max(...values.map((item) => item.value), 1);
  return <div className="metric-bars" style={{ display: "grid", gap: 14 }}>{values.map((item, index) => <div className="metric-bar-row" key={`${item.label}-${index}`} style={{ display: "grid", gridTemplateColumns: "88px minmax(0, 1fr) 48px", gap: 10, alignItems: "center", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }}><span>{item.label}</span><div className="metric-bar-track" style={{ height: 10, background: "var(--ink)", border: "1px solid var(--line)" }}><i style={{ display: "block", height: "100%", width: `${Math.max((item.value / maximum) * 100, item.value ? 4 : 0)}%`, background: colors[index % colors.length] }} /></div><b style={{ textAlign: "right" }}>{item.value.toLocaleString()}</b></div>)}</div>;
}

function LineChart({ values }: { values: number[] }) {
  if (!values.length) return <div className="empty">No completed execution timestamps available.</div>;
  const maximum = Math.max(...values, 1);
  const points = values.map((value, index) => `${(index / Math.max(values.length - 1, 1)) * 100},${100 - (value / maximum) * 84 - 8}`).join(" ");
  return <svg className="metric-line" style={{ display: "block", width: "100%", height: 180, background: "linear-gradient(to bottom, transparent 24%, var(--line) 25%, transparent 26%, transparent 49%, var(--line) 50%, transparent 51%, transparent 74%, var(--line) 75%, transparent 76%)" }} viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Jobs completed over time"><polyline points={points} fill="none" stroke="var(--cyan)" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>;
}

function MetricPanel({ title, icon, children, detail }: { title: string; icon: React.ReactNode; children: React.ReactNode; detail?: string }) {
  return <section className="panel metric-panel"><div className="panel-head"><h3 className="panel-title">{title}</h3>{icon}</div>{children}{detail && <p className="metric-detail subtle" style={{ marginBottom: 0, lineHeight: 1.5 }}>{detail}</p>}</section>;
}

export default function MetricsPage() {
  const { jobs, workers, events, socketStatus, loading: schedulerLoading, error: schedulerError, reload } = useSchedulerData();
  const [data, setData] = useState<MetricData | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const load = async () => {
    try {
      const [executions, scheduled, dlq, text] = await Promise.all([apiClient.allExecutions(), apiClient.allScheduledJobs(), apiClient.dlq(), apiText("/metrics")]);
      setData({ executions, scheduled, dlqCount: dlq.data.length, text });
      setMetricsError(null);
    } catch (err) { setMetricsError(err instanceof Error ? err.message : "Unable to load metrics"); }
  };
  useEffect(() => { void load(); const unsubscribe = subscribeSocket((event) => { if (event.type === "worker.heartbeat") return; if (refreshTimerRef.current !== null) return; refreshTimerRef.current = window.setTimeout(() => { refreshTimerRef.current = null; void load(); void reload(); }, 10000); }); return () => { unsubscribe(); if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current); }; }, []);

  if (schedulerLoading || !data) return <><PageHeader eyebrow="Operations / metrics" title="Metrics console" detail="Live measurements from scheduler APIs, database records, and Prometheus counters." />{(schedulerError || metricsError) && <Failure message={schedulerError ?? metricsError ?? "Unable to load metrics"} />}<Loading /></>;
  const completed = jobs.filter((job) => job.status === "COMPLETED").length;
  const failed = jobs.filter((job) => job.status === "FAILED").length;
  const queueDepth = prometheusValue(data.text, "queue_depth");
  const retryCount = prometheusValue(data.text, "jobs_retried_total");
  const processedOverTime = jobs.filter((job) => job.completedAt).sort((a, b) => new Date(a.completedAt!).getTime() - new Date(b.completedAt!).getTime()).map((_, index) => index + 1);
  const durations = data.executions.filter((execution) => execution.durationMs !== null && execution.durationMs !== undefined).slice(-12);
  const utilization = workers.map((worker) => ({ label: worker.name, value: worker.concurrency ? Math.round((worker.currentJobCount / worker.concurrency) * 100) : 0 }));
  return <>
    <PageHeader eyebrow="Operations / metrics" title="Metrics console" detail="Live measurements from scheduler APIs, database records, and Prometheus counters."><button className="button secondary" onClick={() => { void load(); void reload(); }}><RefreshCw size={14} /> Refresh</button></PageHeader>
    {(schedulerError || metricsError) && <Failure message={schedulerError ?? metricsError ?? "Unable to load metrics"} />}
    <div className="grid stats metric-stats">{[["Queued", "QUEUED"], ["Claimed", "CLAIMED"], ["Running", "RUNNING"], ["Completed", "COMPLETED"], ["Failed", "FAILED"], ["Retry", "RETRY"], ["DLQ", "DEAD_LETTER"], ["Scheduled", "SCHEDULED"]].map(([label, status]) => <div className="stat" key={status}><span className="stat-label">{label}</span><strong className="stat-value">{jobs.filter((job) => job.status === status).length}</strong></div>)}</div>
    <div className="grid content-grid metric-grid">
      <MetricPanel title="Jobs processed over time" icon={<Activity size={18} color="var(--cyan)" />} detail="Cumulative completed jobs, using real completedAt timestamps."><LineChart values={processedOverTime} /></MetricPanel>
      <MetricPanel title="Completed vs failed" icon={<BarChart3 size={18} color="var(--cyan)" />}><BarChart values={[{ label: "Completed", value: completed }, { label: "Failed", value: failed }]} colors={["var(--cyan)", "var(--red)"]} /></MetricPanel>
      <MetricPanel title="Queue depth" icon={<Gauge size={18} color="var(--amber)" />} detail="Current backend gauge. Historical queue-depth data is not exposed by the backend."><div className="metric-gauge" style={{ display: "grid", gap: 8 }}><strong style={{ fontSize: 42, color: "var(--amber)" }}>{formatNumber(queueDepth)}</strong><span className="subtle">jobs currently queued, claimed, running, retrying, or scheduled</span></div></MetricPanel>
      <MetricPanel title="Execution duration" icon={<Timer size={18} color="var(--blue)" />} detail="Real durationMs values from execution records."><BarChart values={durations.map((execution) => ({ label: `Attempt ${execution.attemptNumber}`, value: execution.durationMs ?? 0 }))} colors={["var(--blue)"]} /></MetricPanel>
      <MetricPanel title="Worker utilization" icon={<Server size={18} color="var(--cyan)" />} detail="Current jobs divided by each worker's declared concurrency."><BarChart values={utilization} colors={["var(--cyan)"]} /></MetricPanel>
      <MetricPanel title="Retry count" icon={<RefreshCw size={18} color="var(--amber)" />} detail="Prometheus jobs_retried_total counter from the backend."><div className="metric-gauge" style={{ display: "grid", gap: 8 }}><strong style={{ fontSize: 42, color: "var(--amber)" }}>{formatNumber(retryCount)}</strong><span className="subtle">real retry events recorded by the service</span></div></MetricPanel>
      <MetricPanel title="DLQ count" icon={<Clock3 size={18} color="var(--red)" />} detail="Current count from the authenticated dead-letter API."><div className="metric-gauge" style={{ display: "grid", gap: 8 }}><strong style={{ fontSize: 42, color: "var(--red)" }}>{data.dlqCount.toLocaleString()}</strong><span className="subtle">dead-letter records currently exposed</span></div></MetricPanel>
      <MetricPanel title="Scheduled jobs" icon={<Activity size={18} color="var(--amber)" />} detail="Current scheduled-job records from the scheduler API."><BarChart values={[{ label: "Enabled", value: data.scheduled.filter((job) => job.enabled).length }, { label: "Disabled", value: data.scheduled.filter((job) => !job.enabled).length }]} colors={["var(--amber)", "var(--muted)"]} /></MetricPanel>
    </div>
    <p className="metric-updated">{socketStatus === "CONNECTED" ? (events.length ? `WebSocket connected · ${events.length} recent events in memory` : "WebSocket connected · no events received yet") : socketStatus === "RECONNECTING" ? "WebSocket reconnecting" : "WebSocket disconnected"}</p>
  </>;
}
