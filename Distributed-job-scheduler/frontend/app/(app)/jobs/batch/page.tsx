"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiClient, ApiError } from "@/lib/api";
import { subscribeQueue, subscribeSocketStatus, type SocketStatus } from "@/lib/socket";
import type { JobBatch, Queue } from "@/lib/types";
import { Failure, PageHeader } from "@/components/Shell";
import { useSelectedProject } from "@/lib/projectContext";

export default function BatchJobsPage() {
  const router = useRouter();
  const { selectedProject } = useSelectedProject();
  const [queues, setQueues] = useState<Queue[]>([]);
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("DISCONNECTED");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [createdBatch, setCreatedBatch] = useState<JobBatch | null>(null);

  useEffect(() => {
    const unsubscribeStatus = subscribeSocketStatus(setSocketStatus);
    if (!selectedProject) {
      setQueues([]);
      return () => { unsubscribeStatus(); };
    }

    setQueues([]);
    apiClient
      .allQueues(selectedProject.id)
      .then(setQueues)
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load queues"));

    return () => { unsubscribeStatus(); };
  }, [selectedProject]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const queueId = String(data.get("queueId") ?? "").trim();
    const jobType = String(data.get("jobType") ?? "").trim();
    const count = Number(data.get("count"));
    const payloadRaw = String(data.get("payload") ?? "").trim();
    const priority = Number(data.get("priority") ?? 0);
    const maxAttempts = Number(data.get("maxAttempts") ?? 3);

    if (socketStatus !== "CONNECTED") {
      setError("Connect to the scheduler before creating a batch.");
      return;
    }
    if (!selectedProject) {
      setError("Select a project before creating a batch.");
      return;
    }
    if (!queueId || !queues.some((queue) => queue.id === queueId)) {
      setError("Select a queue from the active project.");
      return;
    }
    if (!jobType) {
      setError("A job type is required.");
      return;
    }
    if (!Number.isInteger(count) || count < 1) {
      setError("Job count must be a positive integer.");
      return;
    }
    if (!Number.isInteger(priority)) {
      setError("Priority must be a valid integer.");
      return;
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      setError("Max attempts must be a positive integer.");
      return;
    }

    let payload: unknown;
    try {
      payload = payloadRaw ? JSON.parse(payloadRaw) : {};
    } catch {
      setError("Payload must be valid JSON.");
      return;
    }

    subscribeQueue(queueId);
    try {
      const jobs = Array.from({ length: count }, (_, index) => ({
        jobType,
        payload: typeof payload === "object" && payload !== null && !Array.isArray(payload)
          ? { ...(payload as Record<string, unknown>), batchIndex: index + 1 }
          : { batchIndex: index + 1, value: payload },
        priority,
        maxAttempts,
      }));
      const batch = await apiClient.createBatch(queueId, jobs);
      setCreatedBatch(batch);
      setError(null);
      setMessage("Batch created successfully");
      window.setTimeout(() => router.push(`/jobs?batchId=${encodeURIComponent(batch.id)}`), 600);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Unable to create batch");
    }
  };

  const selectQueue = (event: React.ChangeEvent<HTMLSelectElement>) => {
    if (event.currentTarget.value) subscribeQueue(event.currentTarget.value);
  };

  return <>
    <PageHeader eyebrow="Operations / jobs" title="Create a batch" detail="Create independent durable jobs in one real backend batch." />
    <section className="panel">
      <form className="form-grid" onSubmit={submit}>
        {error && <Failure message={error} />}
        {message && <div className="status-pill">{message}</div>}
        {createdBatch && (
          <div className="status-pill" style={{ display: "grid", gap: 6 }}>
            <strong>Batch ID:</strong>
            <span className="mono">{createdBatch.id}</span>
            <span>Jobs: {createdBatch.totalJobs}</span>
            <span>Pending: {createdBatch.pendingJobs} · Completed: {createdBatch.completedJobs} · Failed: {createdBatch.failedJobs}</span>
          </div>
        )}
        <div className="field"><label htmlFor="queueId">Queue</label><select id="queueId" name="queueId" required onChange={selectQueue} defaultValue=""><option value="">Select queue</option>{queues.map((queue) => <option key={queue.id} value={queue.id}>{queue.name}</option>)}</select></div>
        <div className="field"><label htmlFor="jobType">Job type</label><input id="jobType" name="jobType" required maxLength={200} defaultValue="batch.process" /></div>
        <div className="field"><label htmlFor="count">Number of jobs</label><input id="count" name="count" type="number" min="1" max="10000" defaultValue="100" required /></div>
        <div className="field"><label htmlFor="payload">Payload (JSON)</label><textarea id="payload" name="payload" rows={6} defaultValue={'{\n  "source": "batch-ui"\n}'} required /></div>
        <div className="field"><label htmlFor="priority">Priority</label><input id="priority" name="priority" type="number" defaultValue="0" /></div>
        <div className="field"><label htmlFor="maxAttempts">Max attempts</label><input id="maxAttempts" name="maxAttempts" type="number" min="1" max="50" defaultValue="3" /></div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <button className="button" type="submit" disabled={socketStatus !== "CONNECTED"}>Create Batch</button>
          {createdBatch && <Link className="button secondary" href={`/jobs?batchId=${encodeURIComponent(createdBatch.id)}`}>View Batch</Link>}
        </div>
      </form>
    </section>
  </>;
}
