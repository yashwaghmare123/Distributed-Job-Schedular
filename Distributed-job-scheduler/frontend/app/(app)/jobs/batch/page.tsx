"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiClient, ApiError } from "@/lib/api";
import {
  subscribeQueue,
  subscribeSocketStatus,
  type SocketStatus,
} from "@/lib/socket";
import type { JobBatch, Queue } from "@/lib/types";
import { Failure, PageHeader } from "@/components/Shell";
import { useSelectedProject } from "@/lib/projectContext";

type JobHandlerOption = {
  type: string;
  label: string;
  description: string;
  payloadExample: Record<string, unknown>;
};

export default function BatchJobsPage() {
  const router = useRouter();
  const { selectedProject } = useSelectedProject();

  const [queues, setQueues] = useState<Queue[]>([]);
  const [handlers, setHandlers] = useState<JobHandlerOption[]>([]);
  const [selectedJobType, setSelectedJobType] = useState("");

  const [socketStatus, setSocketStatus] =
    useState<SocketStatus>("DISCONNECTED");

  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [createdBatch, setCreatedBatch] =
    useState<JobBatch | null>(null);

  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribeStatus =
      subscribeSocketStatus(setSocketStatus);

    if (!selectedProject) {
      setQueues([]);
      setHandlers([]);
      setSelectedJobType("");
      setLoading(false);

      return () => {
        unsubscribeStatus();
      };
    }

    setQueues([]);
    setHandlers([]);
    setSelectedJobType("");
    setError(null);
    setLoading(true);

    const loadData = async () => {
      try {
        const [availableQueues, availableHandlers] =
          await Promise.all([
            apiClient.allQueues(selectedProject.id),
            apiClient.jobHandlers(),
          ]);

        setQueues(availableQueues);
        setHandlers(availableHandlers.data);

        if (availableHandlers.data.length > 0) {
          setSelectedJobType(
            availableHandlers.data[0].type,
          );
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Unable to load job capabilities",
        );
      } finally {
        setLoading(false);
      }
    };

    void loadData();

    return () => {
      unsubscribeStatus();
    };
  }, [selectedProject]);

  const submit = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();

    setError(null);
    setMessage("");

    const data = new FormData(event.currentTarget);

    const queueId = String(
      data.get("queueId") ?? "",
    ).trim();

    const jobType = String(
      data.get("jobType") ?? "",
    ).trim();

    const count = Number(data.get("count"));

    const payloadRaw = String(
      data.get("payload") ?? "",
    ).trim();

    const priority = Number(
      data.get("priority") ?? 0,
    );

    const maxAttempts = Number(
      data.get("maxAttempts") ?? 3,
    );

    if (socketStatus !== "CONNECTED") {
      setError(
        "Connect to the scheduler before creating a batch.",
      );
      return;
    }

    if (!selectedProject) {
      setError(
        "Select a project before creating a batch.",
      );
      return;
    }

    if (
      !queueId ||
      !queues.some((queue) => queue.id === queueId)
    ) {
      setError(
        "Select a queue from the active project.",
      );
      return;
    }

    if (!jobType) {
      setError("Select a job type.");
      return;
    }

    // Ensure the selected job type is actually
    // registered by the backend.
    const handlerExists = handlers.some(
      (handler) => handler.type === jobType,
    );

    if (!handlerExists) {
      setError(
        "Selected job type is not supported by the backend.",
      );
      return;
    }

    if (!Number.isInteger(count) || count < 1) {
      setError(
        "Job count must be a positive integer.",
      );
      return;
    }

    if (!Number.isInteger(priority)) {
      setError(
        "Priority must be a valid integer.",
      );
      return;
    }

    if (
      !Number.isInteger(maxAttempts) ||
      maxAttempts < 1
    ) {
      setError(
        "Max attempts must be a positive integer.",
      );
      return;
    }

    let payload: unknown;

    try {
      payload = payloadRaw
        ? JSON.parse(payloadRaw)
        : {};
    } catch {
      setError("Payload must be valid JSON.");
      return;
    }

    subscribeQueue(queueId);

    try {
      /*
       * Create independent durable jobs in the batch.
       *
       * Every job uses the selected REAL registered
       * backend handler. No fake batch.process type.
       */
      const jobs = Array.from(
        { length: count },
        (_, index) => ({
          jobType,

          payload:
            typeof payload === "object" &&
            payload !== null &&
            !Array.isArray(payload)
              ? {
                  ...(payload as Record<
                    string,
                    unknown
                  >),
                  batchIndex: index + 1,
                }
              : {
                  batchIndex: index + 1,
                  value: payload,
                },

          priority,
          maxAttempts,
        }),
      );

      const batch =
        await apiClient.createBatch(
          queueId,
          jobs,
        );

      setCreatedBatch(batch);
      setError(null);
      setMessage(
        "Batch created successfully",
      );

      window.setTimeout(() => {
        router.push(
          `/jobs?batchId=${encodeURIComponent(
            batch.id,
          )}`,
        );
      }, 600);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Unable to create batch",
      );
    }
  };

  const selectQueue = (
    event: React.ChangeEvent<HTMLSelectElement>,
  ) => {
    const queueId =
      event.currentTarget.value;

    if (queueId) {
      subscribeQueue(queueId);
    }
  };

  const selectedHandler = handlers.find(
    (handler) =>
      handler.type === selectedJobType,
  );

  return (
    <>
      <PageHeader
        eyebrow="Operations / jobs"
        title="Create a batch"
        detail="Create independent durable jobs in one real backend batch."
      />

      <section className="panel">
        <form
          className="form-grid"
          onSubmit={submit}
        >
          {error && (
            <Failure message={error} />
          )}

          {message && (
            <div className="status-pill">
              {message}
            </div>
          )}

          {createdBatch && (
            <div
              className="status-pill"
              style={{
                display: "grid",
                gap: 6,
              }}
            >
              <strong>Batch ID:</strong>

              <span className="mono">
                {createdBatch.id}
              </span>

              <span>
                Jobs:{" "}
                {createdBatch.totalJobs}
              </span>

              <span>
                Pending:{" "}
                {createdBatch.pendingJobs} ·
                Completed:{" "}
                {createdBatch.completedJobs} ·
                Failed:{" "}
                {createdBatch.failedJobs}
              </span>
            </div>
          )}

          {/* Queue */}
          <div className="field">
            <label htmlFor="queueId">
              Queue
            </label>

            <select
              id="queueId"
              name="queueId"
              required
              onChange={selectQueue}
              defaultValue=""
            >
              <option value="">
                Select queue
              </option>

              {queues.map((queue) => (
                <option
                  key={queue.id}
                  value={queue.id}
                >
                  {queue.name}
                </option>
              ))}
            </select>
          </div>

          {/* Job Type */}
          <div className="field">
            <label htmlFor="jobType">
              Job type
            </label>

            <select
              id="jobType"
              name="jobType"
              required
              value={selectedJobType}
              onChange={(event) =>
                setSelectedJobType(
                  event.target.value,
                )
              }
              disabled={
                loading ||
                !handlers.length
              }
            >
              <option value="">
                {loading
                  ? "Loading job types..."
                  : "Select job type"}
              </option>

              {handlers.map((handler) => (
                <option
                  value={handler.type}
                  key={handler.type}
                >
                  {handler.label}
                </option>
              ))}
            </select>

            {selectedHandler && (
              <>
                <p className="subtle">
                  {
                    selectedHandler.description
                  }
                </p>

                <pre className="payload-example mono">
                  {JSON.stringify(
                    selectedHandler.payloadExample,
                    null,
                    2,
                  )}
                </pre>
              </>
            )}

            {!loading &&
              !handlers.length && (
                <p className="subtle">
                  No real executable job
                  handlers are currently
                  available in the backend.
                </p>
              )}
          </div>

          {/* Number of Jobs */}
          <div className="field">
            <label htmlFor="count">
              Number of jobs
            </label>

            <input
              id="count"
              name="count"
              type="number"
              min="1"
              max="10000"
              defaultValue="100"
              required
            />
          </div>

          {/* Payload */}
          <div className="field">
            <label htmlFor="payload">
              Payload (JSON)
            </label>

            <textarea
              id="payload"
              name="payload"
              rows={7}
              defaultValue="{\n  \n}"
              placeholder={'{\n  "source": "batch-ui"\n}'}
              required
            />
          </div>

          {/* Priority */}
          <div className="field">
            <label htmlFor="priority">
              Priority
            </label>

            <input
              id="priority"
              name="priority"
              type="number"
              defaultValue="0"
            />
          </div>

          {/* Max Attempts */}
          <div className="field">
            <label htmlFor="maxAttempts">
              Max attempts
            </label>

            <input
              id="maxAttempts"
              name="maxAttempts"
              type="number"
              min="1"
              max="50"
              defaultValue="3"
            />
          </div>

          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "center",
            }}
          >
            <button
              className="button"
              type="submit"
              disabled={
                socketStatus !==
                  "CONNECTED" ||
                loading ||
                !handlers.length ||
                !selectedJobType
              }
            >
              Create Batch
            </button>

            {createdBatch && (
              <Link
                className="button secondary"
                href={`/jobs?batchId=${encodeURIComponent(
                  createdBatch.id,
                )}`}
              >
                View Batch
              </Link>
            )}
          </div>
        </form>
      </section>
    </>
  );
}