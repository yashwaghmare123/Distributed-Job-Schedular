"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/api";
import { subscribeQueue, subscribeSocketStatus, type SocketStatus } from "@/lib/socket";
import type { Project, Queue } from "@/lib/types";
import { Failure, PageHeader } from "@/components/Shell";

const toDateTimeLocalValue = (date: Date) => {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localDate.toISOString().slice(0, 16);
};

const validateFutureDateTime = (label: string, rawValue: string) => {
  if (!rawValue) {
    return `${label} is required.`;
  }

  const date = new Date(rawValue);
  if (Number.isNaN(date.getTime())) {
    return `${label} is invalid.`;
  }

  if (date.getTime() <= Date.now()) {
    return `${label} must be in the future.`;
  }

  return null;
};

export default function NewJobPage() {
  const router = useRouter();
  const [queues, setQueues] = useState<Queue[]>([]);
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("DISCONNECTED");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [executionType, setExecutionType] = useState<"immediate" | "delayed" | "scheduled" | "recurring">("immediate");
  const [scheduledAt, setScheduledAt] = useState("");
  const [nextRunAt, setNextRunAt] = useState("");
  const [cronExpression, setCronExpression] = useState("0 * * * *");
  const [delayMs, setDelayMs] = useState("60000");

  useEffect(() => {
    const future = new Date(Date.now() + 60_000);
    const nextValue = toDateTimeLocalValue(future);
    setScheduledAt(nextValue);
    setNextRunAt(nextValue);

    const unsubscribeStatus = subscribeSocketStatus(setSocketStatus);
    apiClient.projects().then(async ({ data }) => {
      const all = await Promise.all(data.map((project: Project) => apiClient.queues(project.id)));
      setQueues(all.flatMap((result) => result.data));
    }).catch((err) => setError(err instanceof Error ? err.message : "Unable to load queues"));
    return () => { unsubscribeStatus(); };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const queueId = String(data.get("queueId"));
    const payloadValue = String(data.get("payload") ?? "").trim();
    if (socketStatus !== "CONNECTED") {
      setError("Connect to the scheduler before creating a job.");
      return;
    }
    if (executionType === "recurring") {
      const recurringCron = String(data.get("cronExpression") ?? "").trim();
      if (!recurringCron) {
        setError("Please provide a valid cron expression for the recurring job.");
        return;
      }

      const recurringNextRun = String(data.get("nextRunAt") ?? "").trim();
      const nextRunDate = recurringNextRun ? new Date(recurringNextRun) : new Date(Date.now() + 60_000);
      if (Number.isNaN(nextRunDate.getTime())) {
        setError("Next run time is invalid.");
        return;
      }
      if (nextRunDate.getTime() <= Date.now()) {
        setError("Next run time must be in the future.");
        return;
      }

      subscribeQueue(queueId);
      try {
        const scheduledJob = await apiClient.createScheduledJob(queueId, {
          jobType: String(data.get("jobType")),
          payload: payloadValue ? JSON.parse(payloadValue) : {},
          cronExpression: recurringCron,
          nextRunAt: nextRunDate.toISOString(),
          enabled: true
        });
        setMessage(`Created recurring schedule ${scheduledJob.id}`);
        setTimeout(() => router.push(`/scheduled`), 600);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to create recurring schedule");
      }
      return;
    }
    if (executionType === "scheduled") {
      const scheduledError = validateFutureDateTime("Scheduled time", scheduledAt);
      if (scheduledError) {
        setError(scheduledError);
        return;
      }
    }
    if (executionType === "delayed") {
      const delayValue = Number(delayMs);
      if (!Number.isFinite(delayValue) || delayValue <= 0) {
        setError("Delay must be a positive number of milliseconds.");
        return;
      }
    }
    subscribeQueue(queueId);
    try {
      const scheduledAtValue = executionType === "scheduled"
        ? new Date(scheduledAt).toISOString()
        : executionType === "delayed"
          ? new Date(Date.now() + Number(delayMs)).toISOString()
          : undefined;
      const job = await apiClient.createJob(queueId, {
        jobType: String(data.get("jobType")),
        payload: payloadValue ? JSON.parse(payloadValue) : {},
        priority: Number(data.get("priority") ?? 0),
        maxAttempts: Number(data.get("maxAttempts") ?? 3),
        ...(scheduledAtValue ? { scheduledAt: scheduledAtValue } : {})
      }, String(data.get("idempotencyKey") || ""));
      setMessage(`Created ${job.id}`);
      setTimeout(() => router.push(`/jobs/${job.id}`), 600);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create job");
    }
  };

  const selectQueue = (event: React.ChangeEvent<HTMLSelectElement>) => {
    if (event.currentTarget.value) subscribeQueue(event.currentTarget.value);
  };

  return <>
    <PageHeader eyebrow="Operations / jobs" title="Create a job" detail="Write a durable job directly to the selected queue." />
    <section className="panel">
      <form className="form-grid" onSubmit={submit}>
        {error && <Failure message={error} />}
        {message && <div className="status-pill">{message}</div>}
        <div className="field"><label htmlFor="queueId">Queue</label><select id="queueId" name="queueId" required onChange={selectQueue} defaultValue=""><option value="">Select queue</option>{queues.map((queue) => <option key={queue.id} value={queue.id}>{queue.name}</option>)}</select></div>
        <div className="field"><label htmlFor="executionType">Execution type</label><select id="executionType" name="executionType" value={executionType} onChange={(event) => setExecutionType(event.target.value as "immediate" | "delayed" | "scheduled" | "recurring")}><option value="immediate">Immediate</option><option value="delayed">Delayed</option><option value="scheduled">Scheduled</option><option value="recurring">Recurring</option></select></div>
        {executionType === "delayed" && <div className="field"><label htmlFor="delayMs">Delay (ms)</label><input id="delayMs" name="delayMs" type="number" min="1" step="1000" value={delayMs} onChange={(event) => setDelayMs(event.target.value)} placeholder="60000" required /></div>}
        {executionType === "scheduled" && <div className="field"><label htmlFor="scheduledAt">Scheduled At</label><input id="scheduledAt" name="scheduledAt" type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} placeholder="Select date and time" required /></div>}
        {executionType === "recurring" && <div className="field"><label htmlFor="cronExpression">Cron expression</label><input id="cronExpression" name="cronExpression" type="text" value={cronExpression} onChange={(event) => setCronExpression(event.target.value)} placeholder="0 * * * *" required /></div>}
        {executionType === "recurring" && <div className="field"><label htmlFor="nextRunAt">Next run at</label><input id="nextRunAt" name="nextRunAt" type="datetime-local" value={nextRunAt} onChange={(event) => setNextRunAt(event.target.value)} placeholder="Select date and time" /></div>}
        <div className="field"><label htmlFor="jobType">Job type</label><input id="jobType" name="jobType" required maxLength={200} placeholder="e.g. send-email" /></div>
        <div className="field"><label htmlFor="payload">Payload (JSON)</label><textarea id="payload" name="payload" rows={7} defaultValue="{\n  \n}" placeholder={'{\n  "tenant": "acme"\n}'} required /></div>
        <div className="field"><label htmlFor="priority">Priority</label><input id="priority" name="priority" type="number" defaultValue="0" /></div>
        <div className="field"><label htmlFor="maxAttempts">Max attempts</label><input id="maxAttempts" name="maxAttempts" type="number" min="1" max="50" defaultValue="3" /></div>
        <div className="field"><label htmlFor="idempotencyKey">Idempotency key</label><input id="idempotencyKey" name="idempotencyKey" maxLength={255} placeholder="Optional unique key" /></div>
        <button className="button" type="submit" disabled={socketStatus !== "CONNECTED"}>Create durable job</button>
      </form>
    </section>
  </>;
}
