"use client";

import Link from "next/link";
import { Activity, ArrowUpRight, RefreshCw } from "lucide-react";
import { useSchedulerData } from "@/hooks/useScheduler";
import { Failure, Loading, PageHeader, StatusBadge } from "@/components/Shell";
import { OverviewMetrics } from "@/components/OverviewMetrics";

function eventCategory(type: string) {
  if (type.startsWith("worker.")) return "WORKER";
  if (type === "job.retry") return "RETRY";
  if (type === "job.dead_lettered") return "DLQ";
  if (type === "job.scheduled" || type === "job.schedule.promoted") return "SCHEDULER";
  if (type.startsWith("job.")) return "JOB";
  return "QUEUE";
}

function eventSubject(event: { jobId?: string; workerId?: string; queueId?: string }) {
  if (event.jobId) return `job ${event.jobId}`;
  if (event.workerId) return `worker ${event.workerId}`;
  if (event.queueId) return `queue ${event.queueId}`;
  return "scheduler";
}

export default function DashboardPage() {
  const { jobs, workers, events, loading, error, reload } = useSchedulerData();
  const statuses = [
    "QUEUED",
    "CLAIMED",
    "RUNNING",
    "COMPLETED",
    "FAILED",
    "RETRY",
    "DEAD_LETTER",
    "SCHEDULED",
  ];
  return (
    <>
      <PageHeader
        eyebrow="Operations / overview"
        title="System pulse"
        detail="Authoritative state from PostgreSQL, refreshed by live notifications."
      >
        <button className="button secondary" onClick={reload}>
          <RefreshCw size={14} /> Refresh
        </button>
      </PageHeader>
      {error && <Failure message={error} />}
      {loading ? (
        <Loading />
      ) : (
        <>
          <div className="grid stats">
            {statuses.slice(0, 5).map((status) => (
              <div className="stat" key={status}>
                <span className="stat-label">{status.replace("_", " ")}</span>
                <strong className="stat-value">
                  {jobs.filter((job) => job.status === status).length}
                </strong>
              </div>
            ))}
          </div>
          <div className="grid stats">
            {statuses.slice(5).map((status) => (
              <div className="stat" key={status}>
                <span className="stat-label">{status.replace("_", " ")}</span>
                <strong className="stat-value">
                  {jobs.filter((job) => job.status === status).length}
                </strong>
              </div>
            ))}
            <div className="stat">
              <span className="stat-label">Online workers</span>
              <strong className="stat-value">
                {workers.filter((worker) => worker.status === "ONLINE").length}
              </strong>
            </div>
          </div>
          <OverviewMetrics jobs={jobs} workers={workers} events={events.length} />
          <div className="grid content-grid">
            <section className="panel">
              <div className="panel-head">
                <h3 className="panel-title">Recent jobs</h3>
                <Link className="button secondary" href="/jobs">
                  View all <ArrowUpRight size={14} />
                </Link>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Status</th>
                      <th>Attempts</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.slice(0, 8).map((job) => (
                      <tr key={job.id}>
                        <td>
                          <Link href={`/jobs/${job.id}`} className="mono">
                            {job.jobType}
                          </Link>
                        </td>
                        <td>
                          <StatusBadge status={job.status} />
                        </td>
                        <td>
                          {job.attemptCount} / {job.maxAttempts}
                        </td>
                        <td className="subtle">
                          {new Date(job.createdAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {jobs.length === 0 && (
                  <div className="empty">No jobs found.</div>
                )}
              </div>
            </section>
            <section className="panel">
              <div className="panel-head">
                <h3 className="panel-title">Live activity</h3>
                <Activity size={18} color="var(--cyan)" />
              </div>
              <div className="live-feed">
                {events.length ? (
                  events.map((event) => (
                    <div className="feed-item" key={event.eventId}>
                      <strong>{eventCategory(event.type)}</strong>
                      <span>
                        <b>{new Date(event.occurredAt).toLocaleTimeString()}</b>{" "}
                        {eventSubject(event)} · {event.type}
                        {event.payload.status ? ` · ${event.payload.status}` : ""}
                        {event.payload.attemptCount !== undefined
                          ? ` · attempt ${event.payload.attemptCount}`
                          : ""}
                        {event.payload.errorMessage
                          ? ` · ${event.payload.errorMessage}`
                          : ""}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="empty">Waiting for state changes.</div>
                )}
              </div>
            </section>
          </div>
        </>
      )}
    </>
  );
}
