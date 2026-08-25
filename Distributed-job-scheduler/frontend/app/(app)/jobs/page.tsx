"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { apiClient, ApiError } from "@/lib/api";
import type { Job } from "@/lib/types";
import { Failure, Loading, PageHeader, StatusBadge } from "@/components/Shell";
import { useSelectedProject } from "@/lib/projectContext";

const jobStatusOptions = ["QUEUED", "SCHEDULED", "CLAIMED", "RUNNING", "COMPLETED", "FAILED", "RETRY", "DEAD_LETTER", "CANCELLED"] as const;

export default function JobsPage() {
  const searchParams = useSearchParams();
  const { selectedProject } = useSelectedProject();
  const batchId = searchParams.get("batchId");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isBatchView = Boolean(batchId);

  useEffect(() => {
    setLoading(true);
    setError(null);

    const load = async () => {
      try {
        if (batchId) {
          const result = await apiClient.allJobs(selectedProject?.id, `?batchId=${encodeURIComponent(batchId)}`);
          setJobs(result);
          setHasMore(false);
          setTotalPages(null);
          return;
        }

        const result = await apiClient.jobs(`?page=${page}&limit=25${status ? `&status=${status}` : ""}`, selectedProject?.id);
        setJobs(result.data);
        setHasMore(result.pagination.hasMore);
        setTotalPages(result.pagination?.totalPages ?? null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Unable to load jobs");
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [batchId, page, selectedProject?.id, status]);

  const summary = useMemo(() => {
    if (!isBatchView) return null;
    const counts = {
      total: jobs.length,
      queued: jobs.filter((job) => job.status === "QUEUED").length,
      claimed: jobs.filter((job) => job.status === "CLAIMED").length,
      running: jobs.filter((job) => job.status === "RUNNING").length,
      completed: jobs.filter((job) => job.status === "COMPLETED").length,
      failed: jobs.filter((job) => job.status === "FAILED").length,
      retry: jobs.filter((job) => job.status === "RETRY").length,
      dlq: jobs.filter((job) => job.status === "DEAD_LETTER").length,
    };
    return counts;
  }, [isBatchView, jobs]);

  return (
    <>
      <PageHeader
        eyebrow={isBatchView ? "Operations / batch" : "Operations / jobs"}
        title={isBatchView ? "Batch jobs" : "Job ledger"}
        detail={isBatchView ? "Jobs in the selected batch." : "Project-scoped scheduler state and execution history."}
      >
        {isBatchView && (
          <Link className="button secondary" href="/jobs">Back to jobs</Link>
        )}
      </PageHeader>
      <section className="panel">
        {!isBatchView && (
          <div className="panel-head">
            <select
              aria-label="Filter by status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
              style={{
                background: "var(--bg-elevated)",
                color: "var(--text)",
                border: "1px solid var(--line)",
                padding: 9,
                borderRadius: 4,
              }}
            >
              <option value="">All statuses</option>
              {jobStatusOptions.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
            <span style={{ display: "flex", gap: 8 }}>
              <Link className="button secondary" href="/jobs/batch">Create batch</Link>
              <Link className="button" href="/jobs/new">Create job</Link>
            </span>
          </div>
        )}
        {error && <Failure message={error} />}
        {isBatchView && summary && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12, marginBottom: 16 }}>
            <div className="feed-item"><strong>Total</strong><span>{summary.total}</span></div>
            <div className="feed-item"><strong>Queued</strong><span>{summary.queued}</span></div>
            <div className="feed-item"><strong>Claimed</strong><span>{summary.claimed}</span></div>
            <div className="feed-item"><strong>Running</strong><span>{summary.running}</span></div>
            <div className="feed-item"><strong>Completed</strong><span>{summary.completed}</span></div>
            <div className="feed-item"><strong>Failed</strong><span>{summary.failed}</span></div>
            <div className="feed-item"><strong>Retry</strong><span>{summary.retry}</span></div>
            <div className="feed-item"><strong>DLQ</strong><span>{summary.dlq}</span></div>
          </div>
        )}
        {loading ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Job type</th>
                  <th>Status</th>
                  <th>Queue</th>
                  <th>Priority</th>
                  <th>Attempts</th>
                  <th>Scheduled</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <Link href={`/jobs/${job.id}`}>{job.jobType}</Link>
                    </td>
                    <td><StatusBadge status={job.status} /></td>
                    <td>{job.queue?.name ?? "Queue"}</td>
                    <td>{job.priority}</td>
                    <td>{job.attemptCount} / {job.maxAttempts}</td>
                    <td className="subtle">{new Date(job.scheduledAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {jobs.length === 0 && <div className="empty">{isBatchView ? "No jobs found for this batch." : "No jobs match this filter."}</div>}
            {!isBatchView && (page > 1 || hasMore) && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
                <button className="button secondary" type="button" disabled={page === 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</button>
                <span className="subtle">Page {page}{totalPages ? ` of ${totalPages}` : ""}</span>
                <button className="button secondary" type="button" disabled={!hasMore || loading} onClick={() => setPage((current) => current + 1)}>Next</button>
              </div>
            )}
          </div>
        )}
      </section>
    </>
  );
}
