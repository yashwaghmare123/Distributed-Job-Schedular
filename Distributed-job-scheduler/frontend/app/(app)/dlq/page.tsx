"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import type { DlqEntry, Worker } from "@/lib/types";
import { Failure, Loading, PageHeader } from "@/components/Shell";
import { Pagination } from "@/components/Pagination";
import { useSelectedProject } from "@/lib/projectContext";

function formatTimestamp(value?: string | null) {
  return value ? new Date(value).toLocaleString() : "Not available";
}

export default function DlqPage() {
  const { selectedProject } = useSelectedProject();
  const [entries, setEntries] = useState<DlqEntry[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requeueId, setRequeueId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const workerNameById = useMemo(
    () => Object.fromEntries(workers.map((worker) => [worker.id, worker.name])) as Record<string, string>,
    [workers]
  );

  const load = async () => {
    setLoading(true);
    try {
      const [dlqResult, workerResult] = await Promise.all([
        apiClient.dlq(`?page=${page}&limit=25`, selectedProject?.id),
        apiClient.workers("?page=1&limit=100").catch(() => ({ data: [] as Worker[] }))
      ]);
      setEntries((dlqResult.data ?? []).filter((entry) => !entry.requeuedAt));
      setWorkers(workerResult.data);
      setTotalPages(dlqResult.pagination?.totalPages ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load dead letters");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setEntries([]);
    void load();
  }, [page, selectedProject?.id]);

  const requeue = async (entryId: string) => {
    setRequeueId(entryId);
    setMessage(null);
    try {
      const result = await apiClient.requeueDlq(entryId);
      setEntries((current) => current.filter((entry) => entry.id !== entryId));
      setMessage(typeof result.message === "string" ? result.message : "Job requeued from DLQ.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to requeue dead-letter entry");
    } finally {
      setRequeueId(null);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Operations / dead letter"
        title="Dead letter queue"
        detail={selectedProject ? `Project-scoped DLQ records for ${selectedProject.name}.` : "Project-scoped DLQ records."}
      />
      {error && <Failure message={error} />}
      {message && <div className="status-pill">{message}</div>}
      {loading && !error ? (
        <Loading />
      ) : (
        <section className="panel">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Queue</th>
                  <th>Failure reason</th>
                  <th>Attempts</th>
                  <th>Last worker</th>
                  <th>Failed at</th>
                  <th>Retry policy</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const queueDisplay = entry.job?.queue?.name ?? "Not available";
                  const workerDisplay = entry.lastWorkerId ? (workerNameById[entry.lastWorkerId] ?? entry.lastWorkerId) : (entry.job?.claimedBy ? (workerNameById[entry.job.claimedBy] ?? entry.job.claimedBy) : "Not available");
                  return (
                    <tr key={entry.id}>
                      <td><Link href={`/jobs/${entry.jobId}`}>{entry.job?.jobType ?? "Job"}</Link></td>
                      <td>{queueDisplay}</td>
                      <td>
                        <div>{entry.reason}</div>
                        <div className="subtle">{entry.errorMessage ?? "No error message"}</div>
                      </td>
                      <td>{entry.attemptCount}</td>
                      <td>{workerDisplay}</td>
                      <td className="subtle">{formatTimestamp(entry.failedAt)}</td>
                      <td>{entry.job?.queue?.retryPolicy?.name ?? "Not available"}</td>
                      <td>
                        <button className="button secondary" type="button" onClick={() => requeue(entry.id)} disabled={requeueId !== null}>
                          {requeueId === entry.id ? "Requeueing..." : "Requeue"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {entries.length === 0 && <div className="empty">No dead-letter entries are available for the selected project.</div>}
            <Pagination page={page} totalPages={totalPages} loading={loading} onChange={setPage} />
          </div>
        </section>
      )}
    </>
  );
}

