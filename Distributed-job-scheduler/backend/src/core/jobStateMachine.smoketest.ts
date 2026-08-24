import { JobStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import {
  assertValidTransition,
  canTransition,
  InvalidJobStateTransitionError
} from "./jobStateMachine.js";

const legalTransitions: readonly [JobStatus, JobStatus][] = [
  [JobStatus.QUEUED, JobStatus.CLAIMED],
  [JobStatus.QUEUED, JobStatus.CANCELLED],
  [JobStatus.SCHEDULED, JobStatus.QUEUED],
  [JobStatus.SCHEDULED, JobStatus.CANCELLED],
  [JobStatus.CLAIMED, JobStatus.RUNNING],
  [JobStatus.CLAIMED, JobStatus.QUEUED],
  [JobStatus.CLAIMED, JobStatus.CANCELLED],
  [JobStatus.RUNNING, JobStatus.COMPLETED],
  [JobStatus.RUNNING, JobStatus.FAILED],
  [JobStatus.RUNNING, JobStatus.CANCELLED],
  [JobStatus.FAILED, JobStatus.RETRY],
  [JobStatus.FAILED, JobStatus.DEAD_LETTER],
  [JobStatus.RETRY, JobStatus.QUEUED],
  [JobStatus.RETRY, JobStatus.CANCELLED]
];

const invalidTransitions: readonly [JobStatus, JobStatus][] = [
  [JobStatus.COMPLETED, JobStatus.RUNNING],
  [JobStatus.COMPLETED, JobStatus.FAILED],
  [JobStatus.COMPLETED, JobStatus.QUEUED],
  [JobStatus.DEAD_LETTER, JobStatus.QUEUED],
  [JobStatus.DEAD_LETTER, JobStatus.RUNNING],
  [JobStatus.CANCELLED, JobStatus.QUEUED],
  [JobStatus.CANCELLED, JobStatus.RUNNING],
  [JobStatus.RUNNING, JobStatus.QUEUED],
  [JobStatus.CLAIMED, JobStatus.COMPLETED],
  [JobStatus.FAILED, JobStatus.COMPLETED],
  [JobStatus.RETRY, JobStatus.RUNNING],
  [JobStatus.CLAIMED, JobStatus.DEAD_LETTER],
  [JobStatus.SCHEDULED, JobStatus.RUNNING]
];

function verifyStateMachine() {
  for (const [from, to] of legalTransitions) {
    if (!canTransition(from, to)) {
      throw new Error(`Legal transition was rejected: ${from} -> ${to}`);
    }
    assertValidTransition(from, to);
  }

  for (const [from, to] of invalidTransitions) {
    if (canTransition(from, to)) {
      throw new Error(`Illegal transition was accepted: ${from} -> ${to}`);
    }

    try {
      assertValidTransition(from, to);
      throw new Error(`Illegal transition did not throw: ${from} -> ${to}`);
    } catch (error: unknown) {
      if (!(error instanceof InvalidJobStateTransitionError)) {
        throw error;
      }
      if (error.currentState !== from || error.requestedState !== to) {
        throw new Error(`Transition error contained incorrect states for ${from} -> ${to}`);
      }
    }
  }
}

async function main() {
  verifyStateMachine();
  const organizationCount = await prisma.organization.count();
  console.log(`State-machine smoke test passed; organizations=${organizationCount}`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    throw error;
  })
  .finally(async () => prisma.$disconnect());
