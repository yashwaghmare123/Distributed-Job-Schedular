"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import type { DlqEntry } from "@/lib/types";
import { Failure, Loading, PageHeader } from "@/components/Shell";
import { Pagination } from "@/components/Pagination";
import { useSelectedProject } from "@/lib/projectContext";

function formatTimestamp(value?: string | null) {
  return value ? new Date(value).toLocaleString() : "Not available";
}

export default function DlqPage() {
  const { selectedProject } = useSelectedProject();
  const [entries, setEntries] = useState<DlqEntry[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requeueId, setRequeueId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = () =>
    apiClient
      .dlq(`?page=${page}&limit=25`, selectedProject?.id)
      .then((result) => {
        setEntries((result.data ?? []).filter((entry) => !entry.requeuedAt));
        setTotalPages(result.pagination?.totalPages ?? null);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load dead letters"))
      .finally(() => setLoading(false));

  useEffect(() => {
    setEntries([]);
    setLoading(true);
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
                  <th>Retry policy</th>
                  <th>Attempts</th>
                  <th>Last worker</th>
                  <th>Failed at</th>
                  <th>Created at</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const queueDisplay = entry.job?.queue?.name ?? "Queue";
                  return (
                    <tr key={entry.id}>
                      <td><Link href={`/jobs/${entry.jobId}`}>{entry.job?.jobType ?? "Job"}</Link></td>
                      <td>{queueDisplay}</td>
                      <td>
                        {entry.reason}
                        <div className="subtle">{entry.errorMessage ?? "No error message"}</div>
                      </td>
                      <td>{entry.job?.queue?.retryPolicy?.name ?? "Not available"}</td>
                      <td>{entry.attemptCount}</td>
                      <td>{entry.job?.claimedBy ? "Assigned worker" : "Not available"}</td>
                      <td className="subtle">{formatTimestamp(entry.failedAt)}</td>
                      <td className="subtle">{formatTimestamp(entry.createdAt)}</td>
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
