"use client";

import { FormEvent, Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiClient } from "@/lib/api";
import { subscribeQueue, subscribeSocketStatus, type SocketStatus } from "@/lib/socket";
import type { Queue } from "@/lib/types";
import { Failure, PageHeader } from "@/components/Shell";
import { useSelectedProject } from "@/lib/projectContext";

type JobHandlerOption = { type: string; label: string; description: string; payloadExample: Record<string, unknown> };

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

function NewJobForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const mode = searchParams.get("mode");
  const { selectedProject } = useSelectedProject();
  const [queues, setQueues] = useState<Queue[]>([]);
  const [handlers, setHandlers] = useState<JobHandlerOption[]>([]);
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("DISCONNECTED");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [executionType, setExecutionType] = useState<"immediate" | "delayed" | "scheduled" | "recurring">("immediate");
  const [selectedJobType, setSelectedJobType] = useState("");
  const [selectedQueueId, setSelectedQueueId] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [nextRunAt, setNextRunAt] = useState("");
  const [cronExpression, setCronExpression] = useState("0 * * * *");
  const [delaySeconds, setDelaySeconds] = useState("60");

  useEffect(() => {
    if (mode === "delayed" || mode === "scheduled" || mode === "recurring") {
      setExecutionType(mode);
    }

    const future = new Date(Date.now() + 60_000);
    const nextValue = toDateTimeLocalValue(future);
    setScheduledAt(nextValue);
    setNextRunAt(nextValue);

    const unsubscribeStatus = subscribeSocketStatus(setSocketStatus);
    const loadQueues = async () => {
      try {
        if (!selectedProject) return;
        const [availableQueues, availableHandlers] = await Promise.all([
          apiClient.allQueues(selectedProject.id),
          apiClient.jobHandlers()
        ]);
        setQueues(availableQueues);
        setSelectedQueueId((current) => current && availableQueues.some((queue) => queue.id === current)
          ? current
          : availableQueues[0]?.id ?? "");
        setHandlers(availableHandlers.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to load job capabilities");
      }
    };
    void loadQueues();
    return () => { unsubscribeStatus(); };
  }, [mode, selectedProject]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const queueId = String(data.get("queueId"));
    const selectedType = String(data.get("jobType") ?? "").trim();
    const payloadValue = String(data.get("payload") ?? "").trim();
    if (socketStatus !== "CONNECTED") {
      setError("Connect to the scheduler before creating a job.");
      return;
    }
    if (!queueId) {
      setError("A queue is required.");
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
          jobType: String(data.get("jobType") || ""),
          payload: payloadValue ? JSON.parse(payloadValue) : {},
          cronExpression: recurringCron,
          nextRunAt: nextRunDate.toISOString(),
          enabled: true
        });
        setMessage(`Recurring schedule created for ${scheduledJob.jobType}.`);
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
      const delayValue = Number(delaySeconds);
      if (!Number.isFinite(delayValue) || delayValue <= 0) {
        setError("Delay must be a positive number of seconds.");
        return;
      }
    }
    subscribeQueue(queueId);
    try {
      const scheduledAtValue = executionType === "scheduled"
        ? new Date(scheduledAt).toISOString()
        : executionType === "delayed"
          ? new Date(Date.now() + Number(delaySeconds) * 1000).toISOString()
          : undefined;
      const jobPayload: unknown = payloadValue ? JSON.parse(payloadValue) : {};
      const job = await apiClient.createJob(queueId, {
        jobType: selectedType,
        payload: jobPayload,
        priority: Number(data.get("priority") ?? 0),
        maxAttempts: Number(data.get("maxAttempts") ?? 3),
        ...(scheduledAtValue ? { scheduledAt: scheduledAtValue } : {})
      }, String(data.get("idempotencyKey") || ""));
      setMessage(`Job created for ${job.jobType}.`);
      setTimeout(() => router.push(`/jobs/${job.id}`), 600);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create job");
    }
  };

  const selectQueue = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedQueueId(event.currentTarget.value);
    if (event.currentTarget.value) subscribeQueue(event.currentTarget.value);
  };

  const selectedQueue = queues.find((queue) => queue.id === selectedQueueId);

  return <>
    <PageHeader eyebrow="Operations / jobs" title="Create a job" detail="Project-scoped job creation for immediate, delayed, scheduled, and recurring work." />
    <section className="panel">
      <form className="form-grid" onSubmit={submit}>
        {error && <Failure message={error} />}
        {message && <div className="status-pill">{message}</div>}
        <div className="field"><label htmlFor="queueId">Queue</label><select id="queueId" name="queueId" required value={selectedQueueId} onChange={selectQueue}><option value="">Select queue</option>{queues.map((queue) => <option key={queue.id} value={queue.id}>{queue.name}</option>)}</select>{selectedQueue?.retryPolicy && <p className="subtle">Retry policy: {selectedQueue.retryPolicy.name} · {selectedQueue.retryPolicy.maxAttempts} attempts · {selectedQueue.retryPolicy.strategy.toLowerCase()}</p>}</div>
        <div className="field"><label htmlFor="executionType">Execution type</label><select id="executionType" name="executionType" value={executionType} onChange={(event) => setExecutionType(event.target.value as "immediate" | "delayed" | "scheduled" | "recurring")}><option value="immediate">Immediate</option><option value="delayed">Delayed</option><option value="scheduled">Scheduled</option><option value="recurring">Recurring</option></select></div>
        {executionType === "delayed" && <div className="field"><label htmlFor="delaySeconds">Delay (seconds)</label><input id="delaySeconds" name="delaySeconds" type="number" min="1" step="1" value={delaySeconds} onChange={(event) => setDelaySeconds(event.target.value)} placeholder="60" required /></div>}
        {executionType === "scheduled" && <div className="field"><label htmlFor="scheduledAt">Run At</label><input id="scheduledAt" name="scheduledAt" type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} placeholder="Select date and time" required /></div>}
        {executionType === "recurring" && <div className="field"><label htmlFor="cronExpression">Cron expression</label><input id="cronExpression" name="cronExpression" type="text" value={cronExpression} onChange={(event) => setCronExpression(event.target.value)} placeholder="0 * * * *" required /></div>}
        {executionType === "recurring" && <div className="field"><label htmlFor="nextRunAt">Next run at</label><input id="nextRunAt" name="nextRunAt" type="datetime-local" value={nextRunAt} onChange={(event) => setNextRunAt(event.target.value)} placeholder="Select date and time" /></div>}
        <div className="field"><label htmlFor="jobType">Job type</label><select id="jobType" name="jobType" required value={selectedJobType} onChange={(event) => setSelectedJobType(event.target.value)} disabled={!handlers.length}><option value="">Select job type</option>{handlers.map((handler) => <option value={handler.type} key={handler.type}>{handler.label}</option>)}</select>{selectedJobType && <><p className="subtle">{handlers.find((handler) => handler.type === selectedJobType)?.description}</p><pre className="payload-example mono">{JSON.stringify(handlers.find((handler) => handler.type === selectedJobType)?.payloadExample, null, 2)}</pre></>}{!handlers.length && <p className="subtle">No real executable job handlers are currently available in the backend.</p>}</div>
        <div className="field"><label htmlFor="payload">Payload (JSON)</label><textarea id="payload" name="payload" rows={7} defaultValue="{\n  \n}" placeholder={'{\n  "tenant": "acme"\n}'} required /></div>
        <div className="field"><label htmlFor="priority">Priority</label><input id="priority" name="priority" type="number" defaultValue="0" /></div>
        <div className="field"><label htmlFor="maxAttempts">Max attempts</label><input id="maxAttempts" name="maxAttempts" type="number" min="1" max="50" defaultValue="3" /></div>
        <div className="field"><label htmlFor="idempotencyKey">Idempotency key</label><input id="idempotencyKey" name="idempotencyKey" maxLength={255} placeholder="Optional unique key" /></div>
        <button className="button" type="submit" disabled={socketStatus !== "CONNECTED" || !handlers.length}>Create durable job</button>
      </form>
    </section>
  </>;
}

export default function NewJobPage() {
  return (
    <Suspense fallback={<div className="panel empty">Loading job form...</div>}>
      <NewJobForm />
    </Suspense>
  );
}
