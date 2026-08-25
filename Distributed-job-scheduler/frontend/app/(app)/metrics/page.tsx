"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, BarChart3, Clock3, Gauge, RefreshCw, Server, Timer } from "lucide-react";
import { apiClient } from "@/lib/api";
import { Failure, Loading, PageHeader } from "@/components/Shell";
import { subscribeSocket, subscribeSocketStatus, type SocketStatus } from "@/lib/socket";
import { BarChart, DurationChart, LineChart, MultiSeriesLegend, UtilizationBars, colors, formatDateTime } from "@/components/MetricCharts";
import type { DlqEntry, ExecutionRow, Job, QueueDepthSnapshot, ScheduledJob, WorkerUtilization } from "@/lib/types";
import { useSelectedProject } from "@/lib/projectContext";

type RangeKey = "1h" | "6h" | "24h" | "7d" | "30d";
type MetricData = { jobs: Job[]; executions: ExecutionRow[]; scheduled: ScheduledJob[]; dlq: DlqEntry[]; queueHistory: Array<{ queueName: string; snapshots: QueueDepthSnapshot[] }>; workers: WorkerUtilization[] };
const ranges: Array<{ key: RangeKey; label: string; hours: number }> = [{ key: "1h", label: "Last 1 hour", hours: 1 }, { key: "6h", label: "Last 6 hours", hours: 6 }, { key: "24h", label: "Last 24 hours", hours: 24 }, { key: "7d", label: "Last 7 days", hours: 168 }, { key: "30d", label: "Last 30 days", hours: 720 }];

function MetricPanel({ title, icon, children, detail }: { title: string; icon: React.ReactNode; children: React.ReactNode; detail: string }) { return <section className="panel metric-panel"><div className="panel-head"><div><h3 className="panel-title">{title}</h3><p className="metric-detail subtle">{detail}</p></div>{icon}</div>{children}</section>; }
function inRange(value: string | null | undefined, hours: number) { return Boolean(value && new Date(value).getTime() >= Date.now() - hours * 3_600_000); }

export default function MetricsPage() {
  const { selectedProject } = useSelectedProject();
  const projectId = selectedProject?.id ?? null;
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("DISCONNECTED");
  const [range, setRange] = useState<RangeKey>("24h");
  const [data, setData] = useState<MetricData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshTimerRef = useRef<number | null>(null);
  const refreshIntervalRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const retryAttemptRef = useRef(0);
  const activeProjectRef = useRef<string | null>(projectId);
  const requestSequenceRef = useRef(0);
  const loadRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const selectedRange = ranges.find((item) => item.key === range) ?? ranges[2];

  const load = async () => {
    if (!projectId) return;
    const requestSequence = ++requestSequenceRef.current;
    setRefreshing(true);
    try {
      const [jobs, executions, scheduled, dlq, queues, utilization] = await Promise.all([apiClient.allJobs(projectId), apiClient.allExecutions(projectId), apiClient.allScheduledJobs(projectId), apiClient.allDlq(projectId), apiClient.allQueues(projectId), apiClient.workerUtilization(projectId)]);
      const queueHistory = await Promise.all(queues.map(async (queue) => ({ queueName: queue.name, snapshots: (await apiClient.queueDepthHistory(projectId, queue.id, selectedRange.hours)).data })));
      if (activeProjectRef.current !== projectId || requestSequence !== requestSequenceRef.current) return;
      setData({ jobs, executions, scheduled, dlq, queueHistory, workers: utilization.workers });
      setError(null);
      retryAttemptRef.current = 0;
    } catch (err) {
      if (activeProjectRef.current === projectId && requestSequence === requestSequenceRef.current) {
        const rateLimited = err instanceof Error && "status" in err && err.status === 429;
        setError(rateLimited ? "Metrics temporarily rate limited. Retrying shortly." : err instanceof Error ? err.message : "Unable to load metrics");
        if (rateLimited && retryTimerRef.current === null) {
          const delay = Math.min(5000 * 2 ** retryAttemptRef.current, 60000);
          retryAttemptRef.current += 1;
          retryTimerRef.current = window.setTimeout(() => { retryTimerRef.current = null; void loadRef.current(); }, delay);
        }
      }
    }
    finally { setRefreshing(false); }
  };

  loadRef.current = load;
  useEffect(() => {
    activeProjectRef.current = projectId;
    requestSequenceRef.current += 1;
    setData(null);
    void loadRef.current();
    refreshIntervalRef.current = window.setInterval(() => void loadRef.current(), 60000);
    const unsubscribeStatus = subscribeSocketStatus(setSocketStatus);
    const unsubscribe = subscribeSocket((event) => {
      if (event.projectId !== projectId || event.type === "worker.heartbeat" || refreshTimerRef.current !== null) return;
      refreshTimerRef.current = window.setTimeout(() => { refreshTimerRef.current = null; void loadRef.current(); }, 10000);
    });
    return () => {
      if (refreshIntervalRef.current !== null) window.clearInterval(refreshIntervalRef.current);
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      unsubscribe();
      unsubscribeStatus();
    };
  }, [projectId, range]);

  if (!projectId || !data) return <><PageHeader eyebrow="Operations / metrics" title="Metrics console" detail="Project-scoped measurements from persisted scheduler records." />{error && <Failure message={error} />}<Loading /></>;
  const executions = data.executions.filter((execution) => inRange(execution.completedAt ?? execution.startedAt, selectedRange.hours));
  const completed = executions.filter((execution) => execution.status === "COMPLETED").length;
  const failed = executions.filter((execution) => execution.status === "FAILED").length;
  const processedPoints = [...new Set(executions.filter((execution) => execution.status === "COMPLETED" && execution.completedAt).map((execution) => { const timestamp = new Date(execution.completedAt!); timestamp.setMinutes(0, 0, 0); return timestamp.toISOString(); }))].sort().map((label) => ({ label, value: executions.filter((execution) => execution.status === "COMPLETED" && execution.completedAt && new Date(execution.completedAt).toISOString().slice(0, 13) === label.slice(0, 13)).length })).reduce((points, point) => [...points, { ...point, value: point.value + (points.at(-1)?.value ?? 0) }], [] as Array<{ label: string; value: number }>);
  const queueValues = ["QUEUED", "CLAIMED", "RUNNING", "RETRY", "SCHEDULED"].map((status) => ({ label: status, value: data.jobs.filter((job) => job.status === status).length }));
  const depthSeries = data.queueHistory.map((item, index) => ({ label: item.queueName, color: colors[index % colors.length], points: item.snapshots.filter((snapshot) => inRange(snapshot.capturedAt, selectedRange.hours)).map((snapshot) => ({ label: snapshot.capturedAt, value: snapshot.queuedCount + snapshot.runningCount, detail: `Queued ${snapshot.queuedCount}, running ${snapshot.runningCount}` })) }));
  const durations = executions.filter((execution) => execution.durationMs !== null && execution.durationMs !== undefined && (execution.completedAt || execution.startedAt)).sort((a, b) => new Date(a.completedAt ?? a.startedAt ?? 0).getTime() - new Date(b.completedAt ?? b.startedAt ?? 0).getTime()).map((execution) => ({ label: execution.completedAt ?? execution.startedAt!, value: execution.durationMs!, detail: `${execution.job.jobType} · attempt ${execution.attemptNumber} · started ${execution.startedAt ? formatDateTime(execution.startedAt) : "unknown"}` }));
  const attempts = [...new Set(executions.map((execution) => execution.attemptNumber))].sort((a, b) => a - b).map((attempt) => ({ label: `Attempt ${attempt}`, value: executions.filter((execution) => execution.attemptNumber === attempt).length }));
  const dlqReasons = [...new Set(data.dlq.filter((entry) => inRange(entry.failedAt, selectedRange.hours)).map((entry) => entry.reason))].map((reason) => ({ label: reason, value: data.dlq.filter((entry) => inRange(entry.failedAt, selectedRange.hours) && entry.reason === reason).length }));
  const scheduled = [{ label: "Enabled", value: data.scheduled.filter((job) => job.enabled).length }, { label: "Disabled", value: data.scheduled.filter((job) => !job.enabled).length }];
  const rangeData = executions.length ? `${formatDateTime(executions.at(-1)?.completedAt ?? executions.at(-1)?.startedAt ?? "")} to ${formatDateTime(executions[0]?.completedAt ?? executions[0]?.startedAt ?? "")}` : "No execution records in selected range";

  return <>
    <PageHeader eyebrow="Operations / metrics" title="Metrics console" detail={`Persisted project metrics · ${selectedRange.label}`}><button className="button secondary" type="button" onClick={() => void loadRef.current()} disabled={refreshing}><RefreshCw size={14} />{refreshing ? "Refreshing..." : "Refresh"}</button></PageHeader>
    {error && <Failure message={error} />}
    <div className="metric-controls"><label>Time range<select value={range} onChange={(event) => setRange(event.target.value as RangeKey)}>{ranges.map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}</select></label><span className="subtle">Data shown only when persisted records exist · {rangeData}</span></div>
    <div className="grid stats metric-stats">{[["Completed", completed], ["Failed", failed], ["Running", data.jobs.filter((job) => job.status === "RUNNING").length], ["Queued", data.jobs.filter((job) => job.status === "QUEUED").length]].map(([label, value]) => <div className="stat" key={label}><span className="stat-label">{label}</span><strong className="stat-value">{value}</strong></div>)}</div>
    <div className="grid content-grid metric-grid">
      <MetricPanel title="Jobs processed over time" icon={<Activity size={18} color="var(--cyan)" />} detail="Completed executions grouped by the real persisted completedAt hour."><LineChart title="Completed executions over time" series={[{ label: "Completed", color: colors[0], points: processedPoints }]} emptyMessage="No completed execution history available yet." /><p className="metric-summary">Total completed: <strong>{completed.toLocaleString()}</strong></p></MetricPanel>
      <MetricPanel title="Completed vs failed" icon={<BarChart3 size={18} color="var(--cyan)" />} detail="Counts from JobExecution records in the selected time range."><BarChart title="Completed versus failed executions" xLabel="Execution status" yLabel="Executions" values={[{ label: "Completed", value: completed }, { label: "Failed", value: failed }]} colors={[colors[0], "#be123c"]} /><p className="metric-summary">Total executions: <strong>{(completed + failed).toLocaleString()}</strong></p></MetricPanel>
      <MetricPanel title="Queue depth" icon={<Gauge size={18} color="var(--amber)" />} detail="Current project jobs by lifecycle state. Zero values remain visible."><BarChart title="Current jobs by lifecycle state" xLabel="Lifecycle state" yLabel="Jobs" values={queueValues} colors={["#b45309", "#4338ca", colors[0], "#be123c", "#64748b"]} /></MetricPanel>
      <MetricPanel title="Queue depth over time" icon={<Gauge size={18} color="var(--amber)" />} detail="Queued plus running counts from separate persisted snapshot series per queue."><LineChart title="Queue depth over time" series={depthSeries} emptyMessage="No queue depth history available yet." /><div className="metric-legend"><MultiSeriesLegend series={depthSeries} /></div></MetricPanel>
      <MetricPanel title="Execution duration" icon={<Timer size={18} color="var(--blue)" />} detail="Duration in milliseconds plotted at each real execution timestamp."><DurationChart values={durations} /></MetricPanel>
      <MetricPanel title="Worker utilization" icon={<Server size={18} color="var(--cyan)" />} detail="Current running jobs divided by each worker's configured concurrency."><UtilizationBars workers={data.workers} /></MetricPanel>
      <MetricPanel title="Retry attempts" icon={<RefreshCw size={18} color="var(--amber)" />} detail="Persisted JobExecution attemptNumber distribution."><BarChart title="Executions by attempt number" xLabel="Attempt number" yLabel="Executions" values={attempts} colors={["#b45309"]} emptyMessage="No execution attempts available yet." /></MetricPanel>
      <MetricPanel title="Dead-letter entries" icon={<Clock3 size={18} color="var(--red)" />} detail="Real DLQ reason fields in the selected time range."><BarChart title="Dead-letter entries by reason" xLabel="Reason" yLabel="Entries" values={dlqReasons} colors={["#be123c"]} emptyMessage="No dead-lettered jobs." /></MetricPanel>
      <MetricPanel title="Scheduled jobs" icon={<Activity size={18} color="var(--amber)" />} detail="Current recurring schedule records from the project-scoped scheduler API."><BarChart title="Scheduled jobs by status" xLabel="Schedule status" yLabel="Jobs" values={scheduled} colors={["#b45309", "#64748b"]} emptyMessage="No scheduled jobs available yet." /></MetricPanel>
    </div>
    <p className="metric-updated">{socketStatus === "CONNECTED" ? "WebSocket connected · authoritative refresh after project events" : socketStatus === "RECONNECTING" ? "WebSocket reconnecting" : "WebSocket disconnected"}</p>
  </>;
}
