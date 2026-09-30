// Local web server for Site Snapper. Runs on your machine only (127.0.0.1).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');
const express = require('express');
const { runJob } = require('./lib/crawler');

const PORT = Number(process.env.PORT) || 4321;
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const jobs = new Map();

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

app.post('/api/jobs', (req, res) => {
  const b = req.body || {};
  let url = String(b.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Paste a URL to start.' });
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch { return res.status(400).json({ error: 'That URL does not look valid.' }); }

  const viewports = (Array.isArray(b.viewports) ? b.viewports : ['desktop']).filter((v) => ['desktop', 'mobile'].includes(v));
  const options = {
    url,
    maxPages: clampInt(b.maxPages, 1, 1000, 100),
    concurrency: clampInt(b.concurrency, 1, 6, 3),
    viewports: viewports.length ? viewports : ['desktop'],
    useSitemap: b.useSitemap !== false,
    expand: b.expand !== false,
    captureTabs: b.captureTabs !== false,
    dismissCookies: b.dismissCookies !== false,
    pdf: b.pdf !== false,
    keepQuery: !!b.keepQuery,
    scopePath: b.scopeToPath ? new URL(url).pathname.replace(/\/+$/, '') || '' : '',
    exclude: String(b.exclude || '').split(/[\n,]/).map((s) => s.trim().toLowerCase()).filter(Boolean),
    authUser: String(b.authUser || '').trim(),
    authPass: String(b.authPass || ''),
  };

  const id = crypto.randomUUID();
  const job = { id, options, events: [], clients: new Set(), status: 'running', result: null, cancelled: false };
  jobs.set(id, job);

  const emit = (ev) => {
    job.events.push(ev);
    for (const c of job.clients) c.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  runJob(job, emit)
    .then((result) => { job.status = 'done'; job.result = result; emit({ type: 'done', ...result, zipPath: undefined }); })
    .catch((err) => {
      job.status = 'error';
      emit({ type: 'error', msg: err.message === 'Cancelled' ? 'Cancelled.' : err.message });
      console.error(err);
    });

  res.json({ id });
});

app.get('/api/jobs/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  for (const ev of job.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  job.clients.add(res);
  req.on('close', () => job.clients.delete(res));
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
  if (!job || !job.result) return res.status(404).end();
  const dir = path.dirname(job.result.zipPath);
  const cmd = process.platform === 'darwin' ? `open -R "${job.result.zipPath}"` : process.platform === 'win32' ? `explorer /select,"${job.result.zipPath}"` : `xdg-open "${dir}"`;
  exec(cmd, () => {});
  res.json({ ok: true });
});

app.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Site Snapper is running at ${url}\n  Press Ctrl+C to stop.\n`);
  if (!process.env.NO_OPEN) {
    const cmd = process.platform === 'darwin' ? `open ${url}` : process.platform === 'win32' ? `start ${url}` : `xdg-open ${url}`;
    exec(cmd, () => {});
  }
});
