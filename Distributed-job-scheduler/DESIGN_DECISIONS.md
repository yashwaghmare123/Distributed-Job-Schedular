# Design Decisions

- `Job.scheduledAt` serves double duty: it records the initial eligibility time for delayed or scheduled jobs, and the retry backoff eligibility time for jobs in `RETRY` status.