"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import type { Worker } from "@/lib/types";
import { Failure, Loading, PageHeader, StatusBadge } from "@/components/Shell";
import { Pagination } from "@/components/Pagination";

export default function WorkersPage() {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setWorkers([]);
    setLoading(true);
    apiClient
      .workers(`?page=${page}&limit=25`)
      .then((result) => { setWorkers(result.data); setTotalPages(result.pagination?.totalPages ?? null); })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Unable to load workers"),
      )
      .finally(() => setLoading(false));
  }, [page]);
  return (
    <>
      <PageHeader
        eyebrow="Operations / workers"
        title="Shared worker fleet"
        detail="Workers are organization-shared infrastructure; project ownership is not modeled by the backend."
      />
      {error && <Failure message={error} />}
      {loading && !error ? (
        <Loading />
      ) : (
        <section className="panel">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Status</th>
                  <th>Current jobs</th>
                  <th>Working on</th>
                  <th>Concurrency</th>
                  <th>Last heartbeat</th>
                </tr>
              </thead>
              <tbody>
                {workers.map((worker) => (
                  <tr key={worker.id}>
                    <td>
                      <Link href={`/workers/${worker.id}`}>{worker.name}</Link>
                      <div className="subtle mono">{worker.id.slice(0, 8)}</div>
                    </td>
                    <td>
                      <StatusBadge status={worker.status} />
                    </td>
                    <td>{worker.currentJobCount}</td>
                    <td>
                      {worker.currentJobs?.length
                        ? worker.currentJobs.map((job) => (
                            <Link key={job.id} href={`/jobs/${job.id}`} style={{ display: "block" }}>
                              {job.jobType}
                            </Link>
                          ))
                        : worker.lastJob
                          ? <><span className="subtle">Last: </span><Link href={`/jobs/${worker.lastJob.id}`}>{worker.lastJob.jobType}</Link></>
                          : <span className="subtle">Idle</span>}
                    </td>
                    <td>{worker.concurrency}</td>
                    <td className="subtle">
                      {worker.lastHeartbeatAt
                        ? new Date(worker.lastHeartbeatAt).toLocaleString()
                        : "Never"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {workers.length === 0 && (
              <div className="empty">No workers registered.</div>
            )}
            <Pagination page={page} totalPages={totalPages} loading={loading} onChange={setPage} />
          </div>
        </section>
      )}
    </>
  );
}
