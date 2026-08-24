"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import type { ExecutionRow } from "@/lib/types";
import { Failure, Loading, PageHeader, StatusBadge } from "@/components/Shell";
import { Pagination } from "@/components/Pagination";

export default function ExecutionsPage() {
  const [items, setItems] = useState<ExecutionRow[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLoading(true);
    apiClient
      .executionsList(`?page=${page}&limit=25`)
      .then((result) => { setItems(result.data); setHasMore(result.pagination?.hasMore ?? false); setTotalPages(result.pagination?.totalPages ?? null); })
      .catch((err) =>
        setError(
          err instanceof Error ? err.message : "Unable to load executions",
        ),
      )
      .finally(() => setLoading(false));
  }, [page]);
  return (
    <>
      <PageHeader
        eyebrow="Operations / executions"
        title="Execution history"
        detail="Attempt-level outcomes from the worker runtime."
      />
      {error && <Failure message={error} />}
      {loading ? (
        <Loading />
      ) : (
        <section className="panel">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Attempt</th>
                  <th>Status</th>
                  <th>Worker</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      {item.job.jobType}
                      <div className="subtle mono">
                        {item.job.id.slice(0, 8)}
                      </div>
                    </td>
                    <td>{item.attemptNumber}</td>
                    <td>
                      <StatusBadge status={item.status} />
                    </td>
                    <td>{item.worker.name}</td>
                    <td className="subtle">
                      {item.startedAt
                        ? new Date(item.startedAt).toLocaleString()
                        : "-"}
                    </td>
                    <td>
                      {item.durationMs == null ? "-" : `${item.durationMs} ms`}
                    </td>
                    <td>{item.errorMessage || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {items.length === 0 && (
              <div className="empty">No executions found.</div>
            )}
            <Pagination page={page} totalPages={totalPages} hasMore={hasMore} loading={loading} onChange={setPage} />
          </div>
        </section>
      )}
    </>
  );
}
