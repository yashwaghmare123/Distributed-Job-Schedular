"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import type { DlqEntry } from "@/lib/types";
import { Failure, Loading, PageHeader } from "@/components/Shell";
import { Pagination } from "@/components/Pagination";

export default function DlqPage() {
  const [entries, setEntries] = useState<DlqEntry[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requeueId, setRequeueId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = () =>
    apiClient
      .dlq(`?page=${page}&limit=25`)
      .then((result) => {
        setEntries((result.data ?? []).filter((entry) => !entry.requeuedAt));
        setTotalPages(result.pagination?.totalPages ?? null);
        setError(null);
      })
      .catch((err) =>
        setError(
          err instanceof Error ? err.message : "Unable to load dead letters",
        ),
      )
      .finally(() => setLoading(false));

  useEffect(() => { void load(); }, [page]);

  const requeue = async (entryId: string) => {
    setRequeueId(entryId);
    setMessage(null);
    try {
      const result = await apiClient.requeueDlq(entryId);
      setEntries((current) => current.filter((entry) => entry.id !== entryId));
      setMessage(
        typeof result.message === "string"
          ? result.message
          : "Job requeued from DLQ.",
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to requeue dead-letter entry",
      );
    } finally {
      setRequeueId(null);
    }
  };

  const lifecycleTrace =
    "FAILED → RETRY → FAILED → RETRY → FAILED → DEAD_LETTER";

  return (
    <>
      <PageHeader
        eyebrow="Operations / dead letter"
        title="Dead letter queue"
        detail="Failed work requiring operator attention."
      />
      {error && <Failure message={error} />}
      {message && <div className="status-pill">{message}</div>}
      <section className="panel" style={{ marginBottom: 18 }}>
        <div className="panel-head">
          <h3 className="panel-title">Failure cycle</h3>
        </div>
        <p className="subtle" style={{ margin: 0 }}>
          {lifecycleTrace}
        </p>
      </section>
      {loading && !error ? (
        <Loading />
      ) : (
        <section className="panel">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Job ID</th>
                  <th>Queue</th>
                  <th>Failure reason</th>
                  <th>Attempts</th>
                  <th>Last worker</th>
                  <th>Failed time</th>
                  <th>DLQ time</th>
                  <th>Requeue</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const queueDisplay =
                    entry.job?.queue?.name ?? entry.job?.queueId ?? entry.jobId;
                  return (
                    <tr key={entry.id}>
                      <td className="mono">{entry.jobId.slice(0, 8)}</td>
                      <td className="mono">{queueDisplay}</td>
                      <td>
                        {entry.reason}
                        <div className="subtle">
                          {entry.errorMessage || "No error message"}
                        </div>
                      </td>
                      <td>{entry.attemptCount}</td>
                      <td className="mono">
                        {entry.lastWorkerId?.slice(0, 8) || "-"}
                      </td>
                      <td className="subtle">
                        {new Date(entry.failedAt).toLocaleString()}
                      </td>
                      <td className="subtle">
                        {new Date(entry.createdAt).toLocaleString()}
                      </td>
                      <td>
                        <button
                          className="button secondary"
                          type="button"
                          onClick={() => requeue(entry.id)}
                          disabled={requeueId !== null}
                        >
                          {requeueId === entry.id ? "Requeueing..." : "Requeue"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {entries.length === 0 && (
              <div className="empty">The dead letter queue is clear.</div>
            )}
            <Pagination page={page} totalPages={totalPages} loading={loading} onChange={setPage} />
          </div>
        </section>
      )}
    </>
  );
}
