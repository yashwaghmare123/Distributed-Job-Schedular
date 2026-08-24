import type { Job } from "@prisma/client";
import { WorkerRuntime, type JobHandler, type JobExecutionResult } from "./workerRuntime.js";

export type DispatcherOptions = { workerId: string; queueId: string; handler: JobHandler };

export class Dispatcher {
  private readonly runtime: WorkerRuntime;

  constructor(options: DispatcherOptions) {
    this.runtime = new WorkerRuntime(options);
  }

  async dispatchOnce(): Promise<Job | null> {
    return this.runtime.runOnce();
  }

  async executeClaimed(job: Job): Promise<JobExecutionResult> {
    return this.runtime.executeJob(job);
  }
}