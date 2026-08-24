import { JobStatus } from "@prisma/client";

const transitions: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  [JobStatus.QUEUED]: [JobStatus.CLAIMED, JobStatus.CANCELLED],
  [JobStatus.SCHEDULED]: [JobStatus.QUEUED, JobStatus.CANCELLED],
  [JobStatus.CLAIMED]: [JobStatus.RUNNING, JobStatus.QUEUED, JobStatus.CANCELLED],
  [JobStatus.RUNNING]: [JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED],
  [JobStatus.COMPLETED]: [],
  [JobStatus.FAILED]: [JobStatus.RETRY, JobStatus.DEAD_LETTER],
  [JobStatus.RETRY]: [JobStatus.QUEUED, JobStatus.CANCELLED],
  [JobStatus.DEAD_LETTER]: [],
  [JobStatus.CANCELLED]: []
};

export class InvalidJobStateTransitionError extends Error {
  readonly currentState: JobStatus;
  readonly requestedState: JobStatus;

  constructor(currentState: JobStatus, requestedState: JobStatus) {
    super(`Invalid job state transition: ${currentState} -> ${requestedState}`);
    this.name = "InvalidJobStateTransitionError";
    this.currentState = currentState;
    this.requestedState = requestedState;
  }
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return transitions[from].includes(to);
}

export function assertValidTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidJobStateTransitionError(from, to);
  }
}

export function getAllowedTransitions(from: JobStatus): readonly JobStatus[] {
  return transitions[from];
}
