"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiClient } from "@/lib/api";
import { subscribeJob, subscribeSocket, subscribeSocketStatus, unsubscribeJob, type SocketStatus } from "@/lib/socket";
import type { DlqEntry, Execution, Job, RetryPolicy } from "@/lib/types";
import { Failure, Loading, PageHeader, StatusBadge } from "@/components/Shell";

const statusDescriptions: Record<string, string> = {
  QUEUED: "Waiting for an available worker.",
  SCHEDULED: "Scheduled to become eligible for processing.",
  CLAIMED: "A worker has claimed the job.",
  RUNNING: "The worker is currently executing the job.",
  COMPLETED: "Execution completed successfully.",
  FAILED: "Execution failed and is eligible for retry or DLQ processing.",
  RETRY: "The job is being retried according to its retry policy.",
  DEAD_LETTER: "The job permanently failed and was moved to the dead-letter queue.",
  CANCELLED: "This job was cancelled before completion.",
};

function formatTimestamp(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "Not available";
}

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [job, setJob] = useState<(Job & { executions: Execution[]; deadLetterEntry?: DlqEntry | null }) | null>(null);
  const [retryPolicies, setRetryPolicies] = useState<RetryPolicy[]>([]);
  const [lifecycleEvents, setLifecycleEvents] = useState<Array<{ eventId: string; type: string; jobId?: string; workerId?: string; occurredAt: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("DISCONNECTED");

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [jobResult, policyResult] = await Promise.all([
          apiClient.job(id),
          apiClient.retryPolicies().catch(() => ({ data: [] as RetryPolicy[] })),
        ]);
        if (!active) return;
        setJob(jobResult);
        setRetryPolicies(policyResult.data);
        setError(null);
        subscribeJob(jobResult.id);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Unable to load job");
      }
    };

    void load();
    return () => {
      active = false;
      unsubscribeJob(id);
    };
  }, [id]);

  useEffect(() => {
    const unsubscribe = subscribeSocket((event) => {
      if (!id || event.jobId !== id) return;
      setLifecycleEvents((current) => [
        { eventId: event.eventId, type: event.type, jobId: event.jobId, workerId: event.workerId, occurredAt: event.occurredAt },
        ...current.filter((item) => item.eventId !== event.eventId),
      ].slice(0, 20));
      void apiClient.job(id).then(setJob).catch((err: unknown) => setError(err instanceof Error ? err.message : "Unable to refresh job"));
    });
    const unsubscribeStatus = subscribeSocketStatus(setSocketStatus);
    return () => {
      unsubscribe();
      unsubscribeStatus();
    };
  }, [id]);

  const retryJob = async () => {
    if (!job) return;
    setRetrying(true);
    setRetryMessage(null);
    try {
      const result = await apiClient.retry(job.id);
      const refreshed = await apiClient.job(job.id);
      setJob(refreshed);
      setRetryMessage(result.scheduled ? `Retry scheduled for ${formatTimestamp(result.job.scheduledAt)}.` : "The backend did not schedule a retry.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to retry job");
    } finally {
      setRetrying(false);
    }
  };

  const cancelJob = async () => {
    if (!job) return;
    setCancelling(true);
    try {
      const cancelled = await apiClient.cancel(job.id);
      setJob((current) => current ? { ...current, status: cancelled.status, updatedAt: cancelled.updatedAt } : current);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to cancel job");
    } finally {
      setCancelling(false);
    }
  };

  const policy = useMemo(
    () => job?.queue?.retryPolicy ?? retryPolicies.find((item) => item.id === job?.queue?.retryPolicyId) ?? null,
    [job?.queue?.retryPolicy, job?.queue?.retryPolicyId, retryPolicies]
  );

  if (error) return <><PageHeader eyebrow="Operations / job detail" title="Unavailable" backHref="/project/null/jobs" /><Failure message={error} /></>;
  if (!job) return <><PageHeader eyebrow="Operations / job detail" title="Loading job" backHref="/project/null/jobs" /><Loading /></>;

  const lastExecution = job.executions[job.executions.length - 1];
  const failedExecution = [...job.executions].reverse().find((item) => item.status === "FAILED") ?? null;
  const retryReady = job.status === "FAILED";
  const cancelVisible = ["QUEUED", "SCHEDULED", "CLAIMED", "RUNNING", "RETRY"].includes(job.status);

  return (
    <>
      <PageHeader 
        eyebrow="Operations / job detail" 
        title={job.jobType} 
        detail={job.id}
        backHref={`/project/${job.queue?.projectId}/jobs`}
      >
        <StatusBadge status={job.status} />
        {retryReady && (
          <button className="button secondary" type="button" onClick={retryJob} disabled={retrying}>{retrying ? "Retrying..." : "Retry job"}</button>
        )}
        {cancelVisible && (
          <button className="button secondary" type="button" onClick={cancelJob} disabled={cancelling}>{cancelling ? "Cancelling..." : "Cancel job"}</button>
        )}
      </PageHeader>

      <div className="grid content-grid">
        <section className="panel">
          <div className="panel-head"><h3 className="panel-title">Job metadata</h3></div>
          <div className="feed-item"><strong>Job ID</strong><span className="mono">{job.id}</span></div>
          <div className="feed-item"><strong>Queue</strong><span>{job.queue?.name ?? job.queueId}</span></div>
          <div className="feed-item"><strong>Status</strong><span><StatusBadge status={job.status} /></span></div>
          <div className="feed-item"><strong>Priority</strong><span>{job.priority}</span></div>
          <div className="feed-item"><strong>Project</strong><span>{job.queue?.project?.name ?? "Not available"}</span></div>
          <div className="feed-item"><strong>Created At</strong><span>{formatTimestamp(job.createdAt)}</span></div>
          <div className="feed-item"><strong>Scheduled At</strong><span>{formatTimestamp(job.scheduledAt)}</span></div>
          <div className="feed-item"><strong>Claimed At</strong><span>{formatTimestamp(job.claimedAt)}</span></div>
          <div className="feed-item"><strong>Started At</strong><span>{formatTimestamp(lastExecution?.startedAt ?? null)}</span></div>
          <div className="feed-item"><strong>Completed At</strong><span>{formatTimestamp(lastExecution?.completedAt ?? null)}</span></div>
          <div className="feed-item"><strong>Worker</strong><span>{lastExecution?.workerId ?? job.claimedBy ?? "Not available"}</span></div>
          <div className="feed-item"><strong>Attempt Count</strong><span>{job.attemptCount}</span></div>
          <div className="feed-item"><strong>Maximum Attempts</strong><span>{job.maxAttempts}</span></div>
          <div className="feed-item"><strong>Retry Policy</strong><span>{policy?.name ?? "Not available"}</span></div>
          <div className="feed-item"><strong>Failure Reason</strong><span>{failedExecution?.errorMessage ?? "Not available"}</span></div>
          <div className="feed-item"><strong>Error Code</strong><span>{failedExecution?.errorCode ?? "Not available"}</span></div>
          <div className="feed-item"><strong>Duration</strong><span>{lastExecution?.durationMs == null ? "Not available" : `${lastExecution.durationMs} ms`}</span></div>
          <div className="feed-item"><strong>Status description</strong><span>{statusDescriptions[job.status] ?? "No status description available."}</span></div>
          <div className="feed-item"><strong>Payload</strong><span><pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(job.payload, null, 2)}</pre></span></div>
          {retryMessage && <div className="status-pill" style={{ marginTop: 12 }}>{retryMessage}</div>}
        </section>

        <section className="panel">
          <div className="panel-head"><h3 className="panel-title">Lifecycle</h3></div>
          {job.status === "SCHEDULED" && (
            <div className="feed-item"><strong>Scheduled</strong><span>{formatTimestamp(job.scheduledAt)}</span></div>
          )}
          {job.status === "QUEUED" && (
            <div className="feed-item"><strong>Queued</strong><span>Current backend status</span></div>
          )}
          {job.claimedAt && (
            <div className="feed-item"><strong>Claimed</strong><span>{formatTimestamp(job.claimedAt)}{job.claimedBy ? ` · Worker: ${job.claimedBy}` : ""}</span></div>
          )}
          {job.executions.map((execution) => (
            <div className="feed-item" key={`${execution.id}-running`}>
              <strong>Running · Attempt {execution.attemptNumber}</strong>
              <span>{formatTimestamp(execution.startedAt ?? null)} · Worker: {execution.workerId}</span>
            </div>
          ))}
          {job.executions.filter((execution) => execution.status === "COMPLETED").map((execution) => (
            <div className="feed-item" key={`${execution.id}-completed`}>
              <strong>Completed · Attempt {execution.attemptNumber}</strong>
              <span>{formatTimestamp(execution.completedAt ?? null)}</span>
            </div>
          ))}
          {job.executions.filter((execution) => execution.status === "FAILED").map((execution) => (
            <div className="feed-item" key={`${execution.id}-failed`}>
              <strong>Failed · Attempt {execution.attemptNumber}</strong>
              <span>{formatTimestamp(execution.completedAt ?? null)} · {execution.errorMessage ?? "Not available"}</span>
            </div>
          ))}
          {job.status === "RETRY" && (
            <div className="feed-item"><strong>Retry scheduled</strong><span>{formatTimestamp(job.scheduledAt)}</span></div>
          )}
          {job.status === "DEAD_LETTER" && job.deadLetterEntry && (
            <div className="feed-item"><strong>Dead lettered</strong><span>{formatTimestamp(job.deadLetterEntry.failedAt)}</span></div>
          )}
          <div className="feed-item"><strong>Current status</strong><span>{job.status}</span></div>

          <div className="panel-head" style={{ marginTop: 18 }}><h3 className="panel-title">Retry information</h3></div>
          <div className="feed-item"><strong>Current Attempt</strong><span>{job.attemptCount}</span></div>
          <div className="feed-item"><strong>Maximum Attempts</strong><span>{job.maxAttempts}</span></div>
          <div className="feed-item"><strong>Retry Strategy</strong><span>{policy?.strategy ?? "Not available"}</span></div>
          <div className="feed-item"><strong>Retry Policy Maximum</strong><span>{policy?.maxAttempts ?? "Not available"}</span></div>
          <div className="feed-item"><strong>Initial Delay</strong><span>{policy?.initialDelayMs == null ? "Not available" : `${policy.initialDelayMs / 1000} seconds`}</span></div>
          <div className="feed-item"><strong>Next Retry</strong><span>{job.status === "RETRY" || (job.status === "FAILED" && job.scheduledAt) ? formatTimestamp(job.scheduledAt) : "Not available"}</span></div>

          <div className="panel-head" style={{ marginTop: 18 }}><h3 className="panel-title">Execution history</h3></div>
          {job.executions.length > 0 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Attempt</th>
                    <th>Status</th>
                    <th>Worker</th>
                    <th>Started</th>
                    <th>Completed</th>
                    <th>Duration</th>
                    <th>Failure</th>
                    <th>Error Code</th>
                  </tr>
                </thead>
                <tbody>
                  {job.executions.map((execution) => (
                    <tr key={execution.id}>
                      <td>{execution.attemptNumber}</td>
                      <td><StatusBadge status={execution.status} /></td>
                      <td className="mono">{execution.workerId || "Not available"}</td>
                      <td>{formatTimestamp(execution.startedAt ?? null)}</td>
                      <td>{formatTimestamp(execution.completedAt ?? null)}</td>
                      <td>{execution.durationMs == null ? "Not available" : `${execution.durationMs} ms`}</td>
                      <td>{execution.errorMessage ?? "Not available"}</td>
                      <td className="mono">{execution.errorCode ?? "Not available"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">No execution history available.</div>
          )}

          <div className="panel-head" style={{ marginTop: 18 }}><h3 className="panel-title">Execution logs</h3></div>
          {job.executions.some((execution) => execution.logs?.length) ? (
            <div className="feed-list">
              {job.executions.flatMap((execution) => (execution.logs ?? []).map((log) => (
                <div className="feed-item" key={log.id}>
                  <strong>Attempt {execution.attemptNumber} · {log.level}</strong>
                  <span>{formatTimestamp(log.createdAt)} · {log.message}</span>
                </div>
              )))}
            </div>
          ) : (
            <div className="empty">Execution logs not available.</div>
          )}

          <div className="panel-head" style={{ marginTop: 18 }}><h3 className="panel-title">Live activity</h3></div>
          <div className="feed-item"><strong>Connection</strong><span>{socketStatus === "CONNECTED" ? "Connected" : socketStatus === "RECONNECTING" ? "Connecting" : "Disconnected"}</span></div>
          {lifecycleEvents.length > 0 ? (
            <div className="feed-list">
              {lifecycleEvents.map((event) => (
                <div key={event.eventId} className="feed-item">
                  <strong>{event.type}</strong>
                  <span>{formatTimestamp(event.occurredAt)}{event.workerId ? ` · Worker: ${event.workerId}` : ""}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">{socketStatus === "CONNECTED" ? "No lifecycle events have been received for this job." : "Live updates unavailable."}</div>
          )}

          {job.deadLetterEntry && (
            <>
              <div className="panel-head" style={{ marginTop: 18 }}><h3 className="panel-title">Dead-letter entry</h3></div>
              <div className="feed-item"><strong>Reason</strong><span>{job.deadLetterEntry.reason}</span></div>
              <div className="feed-item"><strong>Attempt Count</strong><span>{job.deadLetterEntry.attemptCount}</span></div>
              <div className="feed-item"><strong>Failed At</strong><span>{formatTimestamp(job.deadLetterEntry.failedAt)}</span></div>
              <div className="feed-item"><strong>Last Worker</strong><span>{job.deadLetterEntry.lastWorkerId ?? "Not available"}</span></div>
              <div className="feed-item"><strong>Error Message</strong><span>{job.deadLetterEntry.errorMessage ?? "Not available"}</span></div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
