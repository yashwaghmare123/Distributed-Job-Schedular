# Demo Guide

Use this as an evaluator narrative. Every step should be grounded in the visible API/dashboard state and the implementation boundaries below.

| Step | WHAT TO SHOW | WHAT TO EXPLAIN | WHY IT MATTERS |
|---|---|---|---|
| 1 | Dashboard overview | PostgreSQL-backed control plane and live status | Establishes system scope |
| 2 | Architecture diagram | API, database, scheduler, workers, Redis roles | Separates durable state from auxiliary services |
| 3 | Worker view | Online worker rows and heartbeat fields | Makes execution ownership visible |
| 4 | Queue view | Queue, priority default, pause flag, retry policy | Shows queue as policy boundary |
| 5 | Submit immediate job | Job form and resulting `QUEUED` row | Demonstrates durable admission |
| 6 | Observe lifecycle | `QUEUED -> CLAIMED -> RUNNING -> COMPLETED` and event feed | Shows ownership and state transitions |
| 7 | Show concurrent claims | Locking test/code path and multiple queues/workers | Explains no-double-claim correctness |
| 8 | Open executions | Attempt number, worker, timing, logs | Shows history separate from current state |
| 9 | Demonstrate retry | Processor test or failed job moving through `RETRY` | Shows backoff and attempt limits |
| 10 | Demonstrate DLQ | Exhausted job and diagnostic entry, then requeue | Shows failure quarantine and operator action |
| 11 | Create a batch | Batch response and child jobs with common batch ID | Shows transactional grouped creation |
| 12 | Show scheduling | Recurring definition, materialized scheduled job, promotion | Distinguishes definition from occurrence |
| 13 | Show worker health | Heartbeat history and stale recovery tests | Explains liveness and ownership recovery |
| 14 | Explain crash recovery | Claimed work returns to queue; running work fails | Makes failure semantics concrete |
| 15 | Navigate dashboard pages | Jobs, executions, workers, DLQ, metrics, health | Demonstrates operational visibility |
| 16 | Open `/metrics` | Actual registered names and process-local nature | Avoids pretending metrics are durable/aggregated |
| 17 | Show WebSocket event | Subscribe to queue/job and receive lifecycle event | Demonstrates low-latency notification |
| 18 | Show test inventory | Locking, retry, recovery, API, WebSocket, frontend suites | Connects claims to evidence without fake results |
| 19 | Close with decisions | PostgreSQL authority, transactions, explicit gaps | Signals engineering judgment and honesty |

When presenting queue concurrency, say that the setting is persisted and displayed but current claiming does not enforce it. When presenting retries and DLQ, distinguish reusable processors from automatic bootstrap wiring. When presenting batches, show the initial counters but explain that execution rollups are not currently maintained.
