"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Activity, BarChart3, CalendarClock, Clock3, Gauge, RefreshCw, Server } from "lucide-react";
import { apiClient } from "@/lib/api";
import { subscribeSocket } from "@/lib/socket";
import { BarChart, LineChart, colors, type MetricPoint } from "@/components/MetricCharts";
import { StatusBadge } from "@/components/Shell";
import type { DlqEntry, ExecutionRow, Job, Queue, ScheduledJob, WorkerUtilization } from "@/lib/types";

type MetricData = { executions: ExecutionRow[]; dlq: DlqEntry[]; queues: Queue[]; scheduled: ScheduledJob[]; workers: WorkerUtilization[] };

type Props = { jobs: Job[]; events: number; projectId: string | null; refreshSignal?: number };

function Panel({ title, icon, detail, children, className = "" }: { title: string; icon: React.ReactNode; detail?: string; children: React.ReactNode; className?: string }) {
  return <section className={`panel overview-panel ${className}`}><div className="panel-head"><div><h3 className="panel-title">{title}</h3>{detail && <p className="metric-detail subtle">{detail}</p>}</div>{icon}</div>{children}</section>;
}

function completedAndFailedByHour(executions: ExecutionRow[]) {
  const buckets = new Map<string, { completed: number; failed: number }>();
  executions.forEach((execution) => {
    const timestamp = execution.completedAt ?? execution.startedAt;
    if (!timestamp || !["COMPLETED", "FAILED"].includes(execution.status)) return;
    const date = new Date(timestamp);
    date.setMinutes(0, 0, 0);
    const label = date.toISOString();
    const bucket = buckets.get(label) ?? { completed: 0, failed: 0 };
    if (execution.status === "COMPLETED") bucket.completed += 1;
    if (execution.status === "FAILED") bucket.failed += 1;
    buckets.set(label, bucket);
  });
  const labels = [...buckets.keys()].sort();
  return [
    { label: "Completed", color: colors[0], points: labels.map((label) => ({ label, value: buckets.get(label)!.completed })) },
    { label: "Failed", color: "#be123c", points: labels.map((label) => ({ label, value: buckets.get(label)!.failed })) }
  ];
}

function QueueStatus({ jobs }: { jobs: Job[] }) {
  const statuses = ["QUEUED", "CLAIMED", "RUNNING", "RETRY", "SCHEDULED"] as const;
  return <div className="summary-list">{statuses.map((status) => <div className="summary-row" key={status}><span>{status}</span><strong>{jobs.filter((job) => job.status === status).length.toLocaleString()}</strong></div>)}</div>;
}

function WorkerStatus({ workers }: { workers: WorkerUtilization[] }) {
  if (!workers.length) return <div className="overview-empty">No project workers available.</div>;
  return <div className="table-wrap"><table><thead><tr><th>Worker</th><th>Status</th><th>Running</th><th>Capacity</th><th>Utilization</th></tr></thead><tbody>{workers.map((worker) => <tr key={worker.workerId}><td>{worker.workerName}</td><td><StatusBadge status={worker.status} /></td><td>{worker.runningJobs}</td><td>{worker.concurrency}</td><td>{Math.round(worker.utilization)}%</td></tr>)}</tbody></table></div>;
}

export function OverviewMetrics({ jobs, events, projectId, refreshSignal = 0 }: Props) {
  const [data, setData] = useState<MetricData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const activeProjectRef = useRef(projectId);
  const requestIdRef = useRef(0);
  const load = async () => {
    if (!projectId) return;
    const requestId = ++requestIdRef.current;
    try {
      const [executions, dlq, queues, scheduled, utilization] = await Promise.all([apiClient.allExecutions(projectId), apiClient.allDlq(projectId), apiClient.allQueues(projectId), apiClient.allScheduledJobs(projectId), apiClient.workerUtilization(projectId)]);
      if (activeProjectRef.current !== projectId || requestId !== requestIdRef.current) return;
      setData({ executions, dlq, queues, scheduled, workers: utilization.workers });
      setError(null);
    } catch (err) { if (activeProjectRef.current === projectId && requestId === requestIdRef.current) setError(err instanceof Error ? err.message : "Unable to load project summary"); }
  };
  useEffect(() => { activeProjectRef.current = projectId; requestIdRef.current += 1; setData(null); void load(); const interval = window.setInterval(() => void load(), 60000); const unsubscribe = subscribeSocket((event) => { if (event.projectId !== projectId || event.type === "worker.heartbeat" || refreshTimerRef.current !== null) return; refreshTimerRef.current = window.setTimeout(() => { refreshTimerRef.current = null; void load(); }, 10000); }); return () => { window.clearInterval(interval); unsubscribe(); if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current); }; }, [projectId, refreshSignal]);
  if (error && !data) return <div className="error">{error}</div>;
  if (!data) return <div className="panel empty">Loading project summary...</div>;

  const failedJobs = jobs.filter((job) => job.status === "FAILED");
  const retryAttempts = data.executions.filter((execution) => execution.attemptNumber > 1).length;
  const durationValues = data.executions.filter((execution) => execution.durationMs !== null && execution.durationMs !== undefined).map((execution) => execution.durationMs!);
  const averageDuration = durationValues.length ? Math.round(durationValues.reduce((sum, value) => sum + value, 0) / durationValues.length) : null;
  const upcoming = data.scheduled.filter((job) => job.enabled && job.nextRunAt).sort((left, right) => new Date(left.nextRunAt).getTime() - new Date(right.nextRunAt).getTime()).slice(0, 5);
  const chartSeries = completedAndFailedByHour(data.executions);
  const totalCompleted = data.executions.filter((execution) => execution.status === "COMPLETED").length;
  const totalFailed = data.executions.filter((execution) => execution.status === "FAILED").length;

  return <>
    {error && <div className="error">{error}</div>}
    <div className="grid overview-kpis"><div className="stat"><span className="stat-label">Total jobs</span><strong className="stat-value">{jobs.length.toLocaleString()}</strong></div><div className="stat"><span className="stat-label">Completed</span><strong className="stat-value">{totalCompleted.toLocaleString()}</strong></div><div className="stat"><span className="stat-label">Failed</span><strong className="stat-value">{totalFailed.toLocaleString()}</strong></div><div className="stat"><span className="stat-label">Running</span><strong className="stat-value">{jobs.filter((job) => job.status === "RUNNING").length.toLocaleString()}</strong></div><div className="stat"><span className="stat-label">Queued</span><strong className="stat-value">{jobs.filter((job) => job.status === "QUEUED").length.toLocaleString()}</strong></div></div>
    <div className="grid overview-charts"><Panel title="Jobs processed over time" icon={<Activity size={18} color="var(--cyan)" />} detail="Completed and failed executions from the selected project."><LineChart title="Jobs processed over time" xLabel="Time" yLabel="Jobs" series={chartSeries} emptyMessage="No historical execution data available yet." /><div className="metric-legend"><span className="metric-legend-item"><i style={{ background: colors[0] }} />Completed</span><span className="metric-legend-item"><i style={{ background: "#be123c" }} />Failed</span></div></Panel><Panel title="Completed vs Failed" icon={<BarChart3 size={18} color="var(--cyan)" />} detail="Execution outcomes for this project."><BarChart title="Completed versus failed executions" xLabel="Outcome" yLabel="Executions" values={[{ label: "Completed", value: totalCompleted }, { label: "Failed", value: totalFailed }]} colors={[colors[0], "#be123c"]} /></Panel></div>
    <div className="grid overview-info-grid"><Panel title="Queue status" icon={<Gauge size={18} color="var(--amber)" />} detail="Current jobs by lifecycle state."><QueueStatus jobs={jobs} /></Panel><Panel title="Workers" icon={<Server size={18} color="var(--cyan)" />} detail="Project-attributed worker capacity and activity."><WorkerStatus workers={data.workers} /></Panel></div>
    <Panel title="Recent jobs" icon={<Clock3 size={18} color="var(--blue)" />} detail="Latest project jobs with persisted execution duration."><div className="table-wrap"><table><thead><tr><th>Job</th><th>Status</th><th>Queue</th><th>Attempts</th><th>Created</th><th>Duration</th></tr></thead><tbody>{jobs.slice(0, 10).map((job) => <tr key={job.id}><td><Link className="mono link" href={`/project/${projectId}/jobs/${job.id}`}>{job.jobType}</Link></td><td><StatusBadge status={job.status} /></td><td>{job.queue?.name ?? "-"}</td><td>{job.attemptCount} / {job.maxAttempts}</td><td>{new Date(job.createdAt).toLocaleString()}</td><td>{job.durationMs === null || job.durationMs === undefined ? "-" : `${job.durationMs} ms`}</td></tr>)}</tbody></table></div>{!jobs.length && <div className="overview-empty">No recent jobs.</div>}{averageDuration !== null && <p className="metric-summary">Average execution: <strong>{averageDuration} ms</strong></p>}</Panel>
    <div className="grid overview-bottom-grid"><Panel title="Recent failures" icon={<RefreshCw size={18} color="var(--red)" />} detail="Failed jobs from the selected project.">{failedJobs.length ? <div className="table-wrap"><table><thead><tr><th>Job</th><th>Error</th><th>Attempts</th><th>Failed at</th><th>Action</th></tr></thead><tbody>{failedJobs.slice(0, 5).map((job) => <tr key={job.id}><td>{job.jobType}</td><td>{job.errorMessage ?? "Execution failed"}</td><td>{job.attemptCount} / {job.maxAttempts}</td><td>{new Date(job.updatedAt).toLocaleString()}</td><td><Link className="link" href={`/project/${projectId}/jobs/${job.id}`}>View</Link></td></tr>)}</tbody></table></div> : <div className="overview-empty">No recent failures.</div>}</Panel><Panel title="Upcoming scheduled jobs" icon={<CalendarClock size={18} color="var(--amber)" />} detail="Enabled schedules ordered by their real nextRunAt.">{upcoming.length ? <div className="summary-list">{upcoming.map((job) => <div className="summary-row schedule-row" key={job.id}><span><strong>{job.jobType}</strong><small>{job.queue.name}</small></span><time>{new Date(job.nextRunAt).toLocaleString()}</time></div>)}</div> : <div className="overview-empty">No upcoming scheduled jobs.</div>}</Panel><Panel title="Operational totals" icon={<BarChart3 size={18} color="var(--blue)" />} detail="Current real project records."><div className="summary-list"><div className="summary-row"><span>Retry attempts</span><strong>{retryAttempts.toLocaleString()}</strong></div><div className="summary-row"><span>Dead letter queue</span><strong>{data.dlq.length.toLocaleString()}</strong></div><div className="summary-row"><span>Scheduled jobs</span><strong>{data.scheduled.length.toLocaleString()}</strong></div></div><div className="overview-links"><Link className="link" href={`/project/${projectId}/dlq`}>View DLQ</Link><Link className="link" href={`/project/${projectId}/executions`}>View executions</Link></div></Panel></div>
    <p className="subtle overview-live">{events ? `${events} recent project events · summary refreshes from backend` : "Waiting for project activity"}</p>
  </>;
}
