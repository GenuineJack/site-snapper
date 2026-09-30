// Web server for Site Snapper. By default it runs on your machine only (127.0.0.1).
// Set HOST=0.0.0.0 to serve it from a hosted container (see Dockerfile).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');
const express = require('express');
const { runJob, checkBrowser } = require('./lib/crawler');
const { resolveStartUrl } = require('./lib/url');
const { serverlessHost, serverlessProblem, genericProblem } = require('./lib/problems');

const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || '127.0.0.1';
const SERVERLESS = serverlessHost();
const IS_LOCAL = !SERVERLESS && ['127.0.0.1', 'localhost', '::1'].includes(HOST);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const jobs = new Map();

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

function sendProblem(res, status, p) {
  res.status(status).json({ error: p.title, problem: p });
}

// Setup check the page runs on load, so problems show up before anyone clicks.
app.get('/api/health', async (req, res) => {
  const p = SERVERLESS ? serverlessProblem(SERVERLESS, `Detected ${SERVERLESS} environment`) : await checkBrowser();
  // 503 when captures can't work, so hosts like Railway won't switch traffic to a broken deploy.
  res.status(p ? 503 : 200).json({ ok: !p, local: IS_LOCAL, problem: p || null });
});

app.post('/api/jobs', async (req, res) => {
  const b = req.body || {};
  const authUser = String(b.authUser || '').trim();
  const authPass = String(b.authPass || '');
  const authHeader = authUser ? 'Basic ' + Buffer.from(`${authUser}:${authPass}`).toString('base64') : null;

  if (SERVERLESS) return sendProblem(res, 503, serverlessProblem(SERVERLESS, `Detected ${SERVERLESS} environment`));
  const browserProblem = await checkBrowser();
  if (browserProblem) return sendProblem(res, 503, browserProblem);

  let start;
  try { start = await resolveStartUrl(b.url, { authHeader }); } catch (err) { return sendProblem(res, 500, genericProblem(err)); }
  if (start.problem) return sendProblem(res, 400, start.problem);
  const url = start.url;

  const viewports = (Array.isArray(b.viewports) ? b.viewports : ['desktop']).filter((v) => ['desktop', 'mobile'].includes(v));
  const options = {
    url,
    maxPages: clampInt(b.maxPages, 1, 1000, 100),
    concurrency: clampInt(b.concurrency ?? process.env.CONCURRENCY, 1, 6, 3),
    viewports: viewports.length ? viewports : ['desktop'],
    useSitemap: b.useSitemap !== false,
    expand: b.expand !== false,
    captureTabs: b.captureTabs !== false,
    dismissCookies: b.dismissCookies !== false,
    pdf: b.pdf !== false,
    keepQuery: !!b.keepQuery,
    scopePath: b.scopeToPath ? new URL(url).pathname.replace(/\/+$/, '') || '' : '',
    exclude: String(b.exclude || '').split(/[\n,]/).map((s) => s.trim().toLowerCase()).filter(Boolean),
    authUser,
    authPass,
  };

  const id = crypto.randomUUID();
  const job = { id, options, events: [], clients: new Set(), status: 'running', result: null, cancelled: false };
  jobs.set(id, job);

  const emit = (ev) => {
    job.events.push(ev);
    const i = job.events.length;
    for (const c of job.clients) c.write(`id: ${i}\ndata: ${JSON.stringify(ev)}\n\n`);
  };
  start.notes.forEach((msg) => emit({ type: 'log', msg }));

  runJob(job, emit)
    .then((result) => { job.status = 'done'; job.result = result; emit({ type: 'done', ...result, zipPath: undefined }); })
    .catch((err) => {
      job.status = 'error';
      if (err.message === 'Cancelled') return emit({ type: 'error', msg: 'Cancelled.', cancelled: true });
      const p = err.problem || genericProblem(err);
      emit({ type: 'error', msg: p.title, problem: p });
      if (!err.problem) console.error(err);
    });

  res.json({ id, url });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ status: job.status, events: job.events.length });
});

app.get('/api/jobs/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  // Resume where the page left off after a dropped connection.
  const since = clampInt(req.query.since ?? req.get('Last-Event-ID'), 0, job.events.length, 0);
  job.events.slice(since).forEach((ev, k) => res.write(`id: ${since + k + 1}\ndata: ${JSON.stringify(ev)}\n\n`));
  job.clients.add(res);
  // Comment pings keep proxies from closing an idle stream during long pages.
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); job.clients.delete(res); });
});

app.post('/api/jobs/:id/cancel', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  job.cancelled = true;
  res.json({ ok: true });
});

app.get('/api/jobs/:id/download', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.result || !fs.existsSync(job.result.zipPath)) return res.status(404).send('Not ready');
  res.download(job.result.zipPath, job.result.fileName);
});

app.post('/api/jobs/:id/reveal', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.result || !IS_LOCAL) return res.status(404).end();
  const dir = path.dirname(job.result.zipPath);
  const cmd = process.platform === 'darwin' ? `open -R "${job.result.zipPath}"` : process.platform === 'win32' ? `explorer /select,"${job.result.zipPath}"` : `xdg-open "${dir}"`;
  exec(cmd, () => {});
  res.json({ ok: true });
});

app.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Site Snapper is running at ${url}\n  Press Ctrl+C to stop.\n`);
  if (!SERVERLESS) {
    checkBrowser().then((p) => {
      if (p) console.log(`  ⚠ ${p.title}\n    ${p.steps.join('\n    ').replace(/`/g, '')}\n`);
      else console.log('  Browser check: OK, Chrome starts and is ready for captures.\n');
    });
  }
  if (IS_LOCAL && !process.env.NO_OPEN) {
    const cmd = process.platform === 'darwin' ? `open ${url}` : process.platform === 'win32' ? `start ${url}` : `xdg-open ${url}`;
    exec(cmd, () => {});
  }
});
