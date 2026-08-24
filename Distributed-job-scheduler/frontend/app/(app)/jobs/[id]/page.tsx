"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiClient } from "@/lib/api";
import { getRecentSocketEvents, subscribeQueue, subscribeSocket } from "@/lib/socket";
import type { DlqEntry, Execution, Job } from "@/lib/types";
import { Failure, Loading, PageHeader, StatusBadge } from "@/components/Shell";

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<(Job & { executions: Execution[]; deadLetterEntry?: DlqEntry | null }) | null>(null);
  const [lifecycleEvents, setLifecycleEvents] = useState(() => getRecentSocketEvents().filter((event) => event.jobId === id));
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = () => apiClient.job(id).then((result) => {
      if (active) {
        setJob(result);
        subscribeQueue(result.queueId);
        setError(null);
      }
    }).catch((err) => {
      if (active) setError(err instanceof Error ? err.message : "Unable to load job");
    });
    void load();
    const interval = window.setInterval(load, 1000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [id]);

  useEffect(() => subscribeSocket((event) => {
    if (event.jobId !== id) return;
    setLifecycleEvents((current) => [event, ...current.filter((item) => item.eventId !== event.eventId)].slice(0, 20));
  }), [id]);

  const retryJob = async () => {
    setRetrying(true);
    setRetryMessage(null);
    try {
      const result = await apiClient.retry(id);
      await apiClient.job(id).then(setJob);
      setRetryMessage(result.scheduled ? `Retry scheduled for ${new Date(result.job.scheduledAt).toLocaleString()}.` : "Retry was not scheduled because the backend rejected it.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to retry job");
    } finally {
      setRetrying(false);
    }
  };

  if (error) return <><PageHeader eyebrow="Operations / job detail" title="Unavailable" /><Failure message={error} /></>;
  if (!job) return <><PageHeader eyebrow="Operations / job detail" title="Loading job" /><Loading /></>;

  const execution = job.executions?.[job.executions.length - 1];
  const failedExecution = job.executions?.find((item) => item.status === "FAILED") ?? null;
  const retryState = job.status === "FAILED"
    ? "Failure detected; retry available"
    : job.status === "RETRY"
      ? "Retry scheduled"
      : job.status === "QUEUED"
        ? "Queued for retry processing"
        : job.status === "CLAIMED"
          ? "Claimed for retry execution"
          : job.status === "RUNNING"
            ? "Retry execution in progress"
            : job.status === "COMPLETED"
              ? "Retry succeeded"
              : "No retry in progress";
  const lifecycleSteps = ["RUNNING", "FAILED", "RETRY", "QUEUED", "CLAIMED", "RUNNING", "COMPLETED"];
  const timeline = [
    { label: "Created", value: job.createdAt },
    { label: "Scheduled", value: job.scheduledAt },
    { label: "Claimed", value: job.claimedAt },
    { label: "Started", value: execution?.startedAt },
    { label: "Completed", value: execution?.completedAt }
  ];
  const formatTimestamp = (label: string, value?: string | null) => value ? new Date(value).toLocaleString() : label === "Claimed" ? "Claim timestamp not available" : "Not available";

  return <>
    <PageHeader eyebrow="Operations / job detail" title={job.jobType} detail={job.id}><Link className="button secondary" href="/jobs">Back to jobs</Link><StatusBadge status={job.status} />{job.status === "FAILED" && <button className="button secondary" type="button" onClick={retryJob} disabled={retrying}>{retrying ? "Retrying..." : "Retry job"}</button>}</PageHeader>
    <div className="grid content-grid">
      <section className="panel">
        <div className="panel-head"><h3 className="panel-title">Job metadata</h3></div>
        <div className="feed-item"><strong>Status</strong><span><StatusBadge status={job.status} /></span></div>
        <div className="feed-item"><strong>Project</strong><span>{job.queue?.project?.name ?? "Not available"}</span></div>
        <div className="feed-item"><strong>Queue</strong><span>{job.queue?.name ?? job.queueId}</span></div>
        <div className="feed-item"><strong>Scheduled At</strong><span>{new Date(job.scheduledAt).toLocaleString()}</span></div>
        <div className="feed-item"><strong>Worker</strong><span>{execution?.workerId ?? job.claimedBy ?? "Not available"}</span></div>
        <p>Priority {job.priority} | Attempt {job.attemptCount} of {job.maxAttempts}</p>
        <div className="feed-item"><strong>Retry state</strong><span>{retryState}</span></div>
        {job.status === "RETRY" && <div className="feed-item"><strong>Retry scheduled time</strong><span>{new Date(job.scheduledAt).toLocaleString()}</span></div>}
        {failedExecution?.errorMessage && <div className="feed-item"><strong>Failure reason</strong><span>{failedExecution.errorMessage}</span></div>}
        {retryMessage && <div className="status-pill">{retryMessage}</div>}
        <p className="subtle">Duration {execution?.durationMs == null ? "Not available" : `${execution.durationMs} ms`}</p>
        <pre className="mono" style={{ whiteSpace: "pre-wrap", color: "var(--cyan)" }}>{JSON.stringify(job.payload, null, 2)}</pre>
      </section>
      <section className="panel">
        <div className="panel-head"><h3 className="panel-title">Failure → Retry lifecycle</h3></div>
        <div className="feed-item"><strong>Flow</strong><span>{lifecycleSteps.join(" → ")}</span></div>
        {job.status === "FAILED" && <div className="feed-item"><strong>Retry action</strong><span>Use the Retry job action to schedule a retry from the failed attempt.</span></div>}
        {job.status === "RETRY" && <div className="feed-item"><strong>Retry scheduled</strong><span>{new Date(job.scheduledAt).toLocaleString()}</span></div>}
        <div className="panel-head"><h3 className="panel-title">Lifecycle timeline</h3></div>
        {timeline.map((item) => <div className="feed-item" key={item.label}><strong>{item.label}</strong><span>{formatTimestamp(item.label, item.value)}</span></div>)}
        <h3 className="panel-title" style={{ marginTop: 22 }}>Live activity</h3>
        {lifecycleEvents.length ? lifecycleEvents.map((event) => <div className="feed-item" key={event.eventId}><strong>{event.type}</strong><span>{event.jobId} | {event.workerId ?? "worker unavailable"} | {new Date(event.occurredAt).toLocaleTimeString()}</span></div>) : <div className="empty">No lifecycle events received for this job.</div>}
        {job.deadLetterEntry && <><h3 className="panel-title" style={{ marginTop: 22 }}>Dead-letter entry</h3><div className="feed-item"><strong>Reason</strong><span>{job.deadLetterEntry.reason}</span></div><div className="feed-item"><strong>Attempts</strong><span>{job.deadLetterEntry.attemptCount}</span></div><div className="feed-item"><strong>Last worker</strong><span>{job.deadLetterEntry.lastWorkerId ?? "Not available"}</span></div><div className="feed-item"><strong>Failed</strong><span>{new Date(job.deadLetterEntry.failedAt).toLocaleString()}</span></div></>}
        {job.executions?.length ? <><h3 className="panel-title" style={{ marginTop: 22 }}>Execution history</h3>{job.executions.map((item) => <div className="feed-item" key={item.id}><strong>Attempt {item.attemptNumber} → {item.status}</strong><span>Worker: {item.workerId} | Error: {item.errorMessage ?? "No failure reason"} | Duration: {item.durationMs == null ? "Not available" : `${item.durationMs} ms`} | Started: {item.startedAt ? new Date(item.startedAt).toLocaleString() : "Not available"} | Completed: {item.completedAt ? new Date(item.completedAt).toLocaleString() : "Not available"}</span></div>)}</> : <div className="empty">No executions recorded.</div>}
      </section>
    </div>
  </>;
}
