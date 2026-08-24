"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiClient, ApiError } from "@/lib/api";
import type { Job } from "@/lib/types";
import { Failure, Loading, PageHeader, StatusBadge } from "@/components/Shell";

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLoading(true);
    setError(null);
    apiClient
      .jobs(`?page=${page}&limit=25${status ? `&status=${status}` : ""}`)
      .then((result) => {
        setJobs(result.data);
        setHasMore(result.pagination.hasMore);
        setTotalPages(result.pagination?.totalPages ?? null);
      })
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Unable to load jobs"),
      )
      .finally(() => setLoading(false));
  }, [page, status]);
  return (
    <>
      <PageHeader
        eyebrow="Operations / jobs"
        title="Job ledger"
        detail="Filter durable scheduler state and inspect execution history."
      />
      <section className="panel">
        <div className="panel-head">
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
            style={{
              background: "#10171e",
              color: "var(--paper)",
              border: "1px solid var(--line)",
              padding: 9,
              borderRadius: 4,
            }}
          >
            <option value="">All statuses</option>
            {[
              "QUEUED",
              "SCHEDULED",
              "CLAIMED",
              "RUNNING",
              "COMPLETED",
              "FAILED",
              "RETRY",
              "DEAD_LETTER",
              "CANCELLED",
            ].map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
          <span style={{ display: "flex", gap: 8 }}>
            <Link className="button secondary" href="/jobs/batch">
              Create batch
            </Link>
            <Link className="button" href="/jobs/new">
              Create job
            </Link>
          </span>
        </div>
        {error && <Failure message={error} />}
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
                      <div className="subtle mono">{job.id.slice(0, 8)}</div>
                    </td>
                    <td>
                      <StatusBadge status={job.status} />
                    </td>
                    <td className="mono">{job.queueId.slice(0, 8)}</td>
                    <td>{job.priority}</td>
                    <td>
                      {job.attemptCount} / {job.maxAttempts}
                    </td>
                    <td className="subtle">
                      {job.status === "SCHEDULED"
                        ? `Scheduled for: ${new Date(job.scheduledAt).toLocaleString()}`
                        : new Date(job.scheduledAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {jobs.length === 0 && (
              <div className="empty">No jobs match this filter.</div>
            )}
            {(page > 1 || hasMore) && (
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
