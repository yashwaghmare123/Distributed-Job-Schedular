"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import type { ScheduledJob } from "@/lib/types";
import { Failure, Loading, PageHeader } from "@/components/Shell";
import { Pagination } from "@/components/Pagination";

export default function ScheduledPage() {
  const [items, setItems] = useState<ScheduledJob[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLoading(true);
    apiClient
      .scheduledJobs(`?page=${page}&limit=25`)
      .then((result) => { setItems(result.data); setTotalPages(result.pagination?.totalPages ?? null); })
      .catch((err) =>
        setError(
          err instanceof Error ? err.message : "Unable to load scheduled jobs",
        ),
      )
      .finally(() => setLoading(false));
  }, [page]);
  return (
    <>
      <PageHeader
        eyebrow="Operations / schedules"
        title="Scheduled jobs"
        detail="Recurring definitions exposed by the scheduler API."
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
                  <th>Job type</th>
                  <th>Queue</th>
                  <th>Schedule</th>
                  <th>Next Run</th>
                  <th>Last Run</th>
                  <th>Run Count</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.jobType}</td>
                    <td>{item.queue.name}</td>
                    <td className="mono">{item.cronExpression}</td>
                    <td className="subtle">
                      {new Date(item.nextRunAt).toLocaleString()}
                    </td>
                    <td className="subtle">
                      {item.lastRunAt
                        ? new Date(item.lastRunAt).toLocaleString()
                        : "Not run yet"}
                    </td>
                    <td>
                      {typeof item.runCount === "number"
                        ? item.runCount
                        : "Not tracked"}
                    </td>
                    <td>
                      {item.status ?? (item.enabled ? "Enabled" : "Disabled")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {items.length === 0 && (
              <div className="empty">No scheduled jobs found.</div>
            )}
            <Pagination page={page} totalPages={totalPages} loading={loading} onChange={setPage} />
          </div>
        </section>
      )}
    </>
  );
}
