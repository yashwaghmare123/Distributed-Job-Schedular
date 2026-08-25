"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import type { ScheduledJob } from "@/lib/types";
import { Failure, Loading, PageHeader } from "@/components/Shell";
import { Pagination } from "@/components/Pagination";
import { useSelectedProject } from "@/lib/projectContext";

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString() : "Not available";
}

export default function ScheduledPage() {
  const { selectedProject } = useSelectedProject();
  const [items, setItems] = useState<ScheduledJob[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    apiClient
      .scheduledJobs(`?page=${page}&limit=25`, selectedProject?.id)
      .then((result) => {
        setItems(result.data);
        setTotalPages(result.pagination?.totalPages ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load scheduled jobs"))
      .finally(() => setLoading(false));
  }, [page, selectedProject?.id]);

  return (
    <>
      <PageHeader
        eyebrow="Operations / schedules"
        title="Scheduled jobs"
        detail={selectedProject ? `Recurring definitions for ${selectedProject.name}.` : "Recurring definitions exposed by the scheduler API."}
      >
        <Link className="button" href="/jobs/new?mode=scheduled">+ Schedule job</Link>
        <Link className="button secondary" href="/jobs/new?mode=recurring">Create recurring</Link>
      </PageHeader>
      {error && <Failure message={error} />}
      {loading ? (
        <Loading />
      ) : (
        <section className="panel">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Schedule</th>
                  <th>Queue</th>
                  <th>Cron</th>
                  <th>Next Run</th>
                  <th>Last Run</th>
                  <th>Run Count</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div>{item.jobType}</div>
                    </td>
                    <td>{item.queue?.name ?? "Queue"}</td>
                    <td className="mono">{item.cronExpression || "Not available"}</td>
                    <td className="subtle">{formatDate(item.nextRunAt)}</td>
                    <td className="subtle">{formatDate(item.lastRunAt ?? null)}</td>
                    <td>{typeof item.runCount === "number" ? item.runCount : "Not available"}</td>
                    <td>{item.status ?? (item.enabled ? "Enabled" : "Disabled")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {items.length === 0 && <div className="empty">No scheduled jobs found for the selected project.</div>}
            <Pagination page={page} totalPages={totalPages} loading={loading} onChange={setPage} />
          </div>
        </section>
      )}
    </>
  );
}
