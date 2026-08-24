"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/api";
import { subscribeQueue, subscribeSocketStatus, type SocketStatus } from "@/lib/socket";
import type { Project, Queue } from "@/lib/types";
import { Failure, PageHeader } from "@/components/Shell";

export default function BatchJobsPage() {
  const router = useRouter();
  const [queues, setQueues] = useState<Queue[]>([]);
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("DISCONNECTED");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const unsubscribeStatus = subscribeSocketStatus(setSocketStatus);
    apiClient.projects().then(async ({ data }) => {
      const results = await Promise.all(data.map((project: Project) => apiClient.queues(project.id)));
      setQueues(results.flatMap((result) => result.data));
    }).catch((err) => setError(err instanceof Error ? err.message : "Unable to load queues"));
    return () => { unsubscribeStatus(); };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (socketStatus !== "CONNECTED") {
      setError("Connect to the scheduler before creating a batch.");
      return;
    }
    subscribeQueue(String(data.get("queueId")));
    try {
      const count = Number(data.get("count"));
      const payload = JSON.parse(String(data.get("payload")));
      const jobs = Array.from({ length: count }, (_, index) => ({
        jobType: String(data.get("jobType")),
        payload: { ...payload, batchIndex: index + 1 },
        priority: Number(data.get("priority")),
        maxAttempts: Number(data.get("maxAttempts"))
      }));
      const batch = await apiClient.createBatch(String(data.get("queueId")), jobs);
      const batchId = typeof batch.id === "string" ? batch.id : "";
      setMessage(`Created ${count} real jobs${batchId ? ` in batch ${batchId}` : ""}`);
      window.setTimeout(() => router.push("/jobs"), 700);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create batch");
    }
  };

  const selectQueue = (event: React.ChangeEvent<HTMLSelectElement>) => {
    if (event.currentTarget.value) subscribeQueue(event.currentTarget.value);
  };

  return <><PageHeader eyebrow="Operations / jobs" title="Create a batch" detail="Create independent durable jobs in one real backend batch." /><section className="panel"><form className="form-grid" onSubmit={submit}>{error && <Failure message={error} />}{message && <div className="status-pill">{message}</div>}<div className="field"><label htmlFor="queueId">Queue</label><select id="queueId" name="queueId" required onChange={selectQueue}><option value="">Select queue</option>{queues.map((queue) => <option key={queue.id} value={queue.id}>{queue.name}</option>)}</select></div><div className="field"><label htmlFor="jobType">Job type</label><input id="jobType" name="jobType" required maxLength={200} defaultValue="batch.process" /></div><div className="field"><label htmlFor="count">Job count</label><input id="count" name="count" type="number" min="1" max="10000" defaultValue="100" required /></div><div className="field"><label htmlFor="payload">Payload (JSON)</label><textarea id="payload" name="payload" rows={6} defaultValue={'{\n  "source": "batch-ui"\n}'} required /></div><div className="field"><label htmlFor="priority">Priority</label><input id="priority" name="priority" type="number" defaultValue="0" /></div><div className="field"><label htmlFor="maxAttempts">Max attempts</label><input id="maxAttempts" name="maxAttempts" type="number" min="1" max="50" defaultValue="3" /></div><button className="button" type="submit" disabled={socketStatus !== "CONNECTED"}>Create real batch</button></form></section></>;
}
