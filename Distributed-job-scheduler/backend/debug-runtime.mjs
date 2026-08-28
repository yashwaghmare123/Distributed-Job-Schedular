import request from 'supertest';
import { WebSocket } from 'ws';
import { createApp, startRuntimeBootstrap } from './src/server.ts';
import { prisma } from './src/lib/prisma.ts';

const app = createApp();
const register = await request(app).post('/auth/register').send({ name: 'dbg', email: `dbg-${Date.now()}@example.test`, password: 'Pass123!' });
const auth = { Authorization: `Bearer ${register.body.accessToken}` };
const project = await request(app).post('/projects').set(auth).send({ name: `dbg-project-${Date.now()}` });
const policy = await prisma.retryPolicy.findFirstOrThrow({ where: { name: 'seed-fixed' } });
const queue = await request(app).post(`/projects/${project.body.id}/queues`).set(auth).send({ name: `dbg-queue-${Date.now()}`, concurrencyLimit: 2, retryPolicyId: policy.id });
const runtime = await startRuntimeBootstrap({ app, port: 0, schedulerPollIntervalMs: 200, workerPollIntervalMs: 50 });
const server = runtime.server;

function openSocket() {
  return new Promise((resolve, reject) => {
    const address = server.address();
    if (!address || typeof address === 'string') return reject(new Error('missing address'));
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws?token=${encodeURIComponent(register.body.accessToken)}`);
    socket.once('open', () => socket.once('message', (data) => {
      const msg = JSON.parse(data.toString());
      console.log('ready', msg);
      if (msg.type === 'ready') resolve(socket); else reject(new Error('not ready'));
    }));
    socket.once('error', reject);
    socket.once('close', (code) => reject(new Error(`closed:${code}`)));
  });
}

try {
  const socket = await openSocket();
  socket.send(JSON.stringify({ type: 'subscribe', queueId: queue.body.id }));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sub timeout')), 5000);
    socket.once('message', (data) => { clearTimeout(timer); const msg = JSON.parse(data.toString()); console.log('sub', msg); resolve(msg); });
  });
  const created = await request(app).post(`/queues/${queue.body.id}/jobs`).set(auth).send({ jobType: 'step15-websocket-lifecycle-job', payload: { ok: true } });
  console.log('created', created.status, created.body);
  socket.on('message', (data) => console.log('socket message', JSON.parse(data.toString())));
  for (let i = 0; i < 30; i++) {
    const job = await prisma.job.findUnique({ where: { id: created.body.id }, select: { status: true, claimedBy: true, claimedAt: true, attemptCount: true, scheduledAt: true, queueId: true } });
    console.log('db tick', i, job);
    if (job?.status === 'COMPLETED') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const finalJob = await prisma.job.findUnique({ where: { id: created.body.id }, include: { executions: true } });
  console.log('finalJob', finalJob);
} finally {
  await runtime.shutdown();
}
