// Site Snapper: crawl a site, expand hidden content, capture full-page screenshots,
// stamp each one with its URL, and bundle everything into a .zip (+ review PDFs).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');
const sharp = require('sharp');
const archiver = require('archiver');
const { PDFDocument, PDFName, PDFString, rgb, StandardFonts } = require('pdf-lib');
const { explainLaunchError, explainPageError, nothingCapturedProblem } = require('./problems');

const VIEWPORTS = {
  desktop: { label: 'Desktop', width: 1440, height: 900, scale: 1, mobile: false },
  mobile: {
    label: 'Mobile', width: 390, height: 844, scale: 2, mobile: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
};

const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|gz|rar|7z|mp3|mp4|mov|avi|webm|wav|docx?|xlsx?|pptx?|csv|txt|xml|json|rss|atom|css|js|woff2?|ttf|eot|dmg|exe)$/i;

// ---------- Browser ----------

// Uses Playwright's bundled Chrome when it was downloaded. If it wasn't, falls
// back to the Google Chrome or Microsoft Edge already installed on the computer,
// so the separate browser download is optional.
async function launchBrowser() {
  if (process.env.CHROMIUM_PATH) {
    return chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH }).catch(launchFailed);
  }
  let firstErr;
  for (const channel of [undefined, 'chrome', 'msedge']) {
    try {
      return await chromium.launch({ headless: true, channel });
    } catch (err) {
      firstErr ||= err;
      // Only move on when that browser simply isn't there; real crashes are reported as-is.
      if (!/Executable doesn't exist|is not found|not installed|ENOENT/i.test(err.message)) return launchFailed(err);
    }
  }
  return launchFailed(firstErr);
}

function launchFailed(err) {
  const e = new Error(String(err.message).split('\n')[0]);
  e.problem = explainLaunchError(err);
  throw e;
}

// Launches and closes the browser once to prove it works. Success is cached;
// failures are re-checked each time so fixing the install needs no restart.
let browserOk = false;
async function checkBrowser() {
  if (browserOk) return null;
  try {
    const b = await launchBrowser();
    await b.close().catch(() => {});
    browserOk = true;
    return null;
  } catch (err) {
    return err.problem;
  }
}

// ---------- URL helpers ----------

function hostKey(u) {
  return u.hostname.replace(/^www\./i, '').toLowerCase();
}

function normalizeUrl(raw, base, opts) {
  let u;
  try { u = new URL(raw, base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  u.hash = '';
  if (!opts.keepQuery) u.search = '';
  else {
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|_ga)/i.test(k)) u.searchParams.delete(k);
    }
  }
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  return u;
}

function inScope(u, root, opts) {
  if (hostKey(u) !== hostKey(root)) return false;
  if (SKIP_EXT.test(u.pathname)) return false;
  if (opts.scopePath && !u.pathname.startsWith(opts.scopePath)) return false;
  const s = u.href.toLowerCase();
  if (opts.exclude.some((x) => x && s.includes(x))) return false;
  if (/\/(wp-admin|wp-login|cart|checkout|my-account|logout|signout)(\/|$)/i.test(u.pathname)) return false;
  return true;
}

function slugFor(u) {
  const p = decodeURIComponent(u.pathname).replace(/^\/+|\/+$/g, '');
  let slug = p ? p.replace(/\//g, '_') : 'home';
  if (u.search) slug += '_' + u.search.slice(1);
  slug = slug.replace(/\.(html?|php|aspx?)$/i, '').replace(/[^a-z0-9_\-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return (slug || 'page').slice(0, 80).toLowerCase();
}

// ---------- Sitemap discovery ----------

async function fetchText(url, authHeader) {
  try {
    const res = await fetch(url, {
      headers: authHeader ? { Authorization: authHeader } : {},
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

async function discoverSitemap(root, authHeader, log) {
  const found = new Set();
  const queue = [];
  const robots = await fetchText(new URL('/robots.txt', root).href, authHeader);
  if (robots) {
    for (const m of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) queue.push(m[1]);
  }
  queue.push(new URL('/sitemap.xml', root).href, new URL('/sitemap_index.xml', root).href);
  const seen = new Set();
  let fetched = 0;
  while (queue.length && fetched < 25) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm);
    const xml = await fetchText(sm, authHeader);
    fetched++;
    if (!xml || !/<(urlset|sitemapindex)/i.test(xml)) continue;
    const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
    if (/<sitemapindex/i.test(xml)) queue.push(...locs);
    else locs.forEach((l) => found.add(l));
  }
  if (found.size) log(`Found ${found.size} URLs in sitemap`);
  else log('No sitemap found, discovering pages by following links');
  return [...found];
}

// ---------- In-page scripts ----------

const KILL_MOTION_CSS = `
  *, *::before, *::after {
    transition: none !important; animation: none !important;
    scroll-behavior: auto !important; caret-color: transparent !important;
  }`;

async function dismissCookieBanners(page) {
  const selectors = [
    '#onetrust-accept-btn-handler', '#truste-consent-button', '.cc-allow', '.cc-dismiss',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '#CybotCookiebotDialogBodyButtonAccept',
    'button[data-cookiefirst-action="accept"]', '.cmplz-accept', '#cookie_action_close_header',
    '[data-testid="uc-accept-all-button"]', '.osano-cm-accept-all', '#hs-eu-confirmation-button',
  ];
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el && (await el.isVisible().catch(() => false))) {
      await el.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(400);
      return;
    }
  }
  // Fallback: an "accept"-style button inside something that looks like a consent banner.
  await page.evaluate(() => {
    const containers = document.querySelectorAll('[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[aria-label*="cookie" i]');
    for (const c of containers) {
      const btn = [...c.querySelectorAll('button,a,[role="button"]')].find((b) =>
        /^(accept( all)?( cookies)?|allow( all)?( cookies)?|agree|i agree|got it|ok(ay)?|understood|close)$/i.test((b.innerText || '').trim()));
      if (btn) { btn.click(); return; }
    }
  }).catch(() => {});
  await page.waitForTimeout(300);
  // Anything consent-like that is still floating over the page gets hidden.
  await page.evaluate(() => {
    document.querySelectorAll('[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[id*="onetrust" i],[id*="gdpr" i],[class*="gdpr" i]').forEach((el) => {
      const pos = getComputedStyle(el).position;
      if ((pos === 'fixed' || pos === 'sticky') && el.getBoundingClientRect().height > 0) el.style.setProperty('display', 'none', 'important');
    });
  }).catch(() => {});
}

// Opens accordions, <details>, Bootstrap collapses and aria-controlled panels.
// Skips navigation menus, dropdowns and popups so they don't cover the page.
async function expandEverything(page) {
  for (let round = 0; round < 3; round++) {
    const clicked = await page.evaluate(() => {
      let n = 0;
      document.querySelectorAll('details:not([open])').forEach((d) => { d.open = true; n++; });
      const triggers = document.querySelectorAll('[aria-expanded="false"]');
      for (const el of triggers) {
        if (el.dataset.ssClicked) continue;
        if (el.closest('header, nav, [role="navigation"], [role="menubar"], [role="menu"], [role="dialog"], [aria-modal="true"]')) continue;
        if (el.getAttribute('aria-haspopup') && el.getAttribute('aria-haspopup') !== 'false') continue;
        if (/menu|nav|hamburger|search|dropdown|toggle-?menu|burger|language|locale/i.test((el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) + ' ' + (el.id || '') + ' ' + (el.getAttribute('aria-label') || ''))) continue;
        if (el.tagName === 'A' && el.getAttribute('href') && !el.getAttribute('href').startsWith('#')) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        el.dataset.ssClicked = '1';
        try { el.click(); n++; } catch {}
      }
      return n;
    }).catch(() => 0);
    if (!clicked) break;
    await page.waitForTimeout(500);
  }

  // Force-show panels, which also covers "only one open at a time" accordions.
  await page.evaluate(() => {
    const show = (p) => {
      if (!p || p.closest('header, nav, [role="navigation"], [role="menu"], [role="dialog"]')) return;
      if (p.getAttribute('role') === 'tabpanel') return; // tabs are captured one at a time
      p.hidden = false;
      p.removeAttribute('hidden');
      p.removeAttribute('inert');
      p.setAttribute('aria-hidden', 'false');
      const s = p.style;
      const cs = getComputedStyle(p);
      if (cs.display === 'none') s.setProperty('display', 'block', 'important');
      s.setProperty('height', 'auto', 'important');
      s.setProperty('max-height', 'none', 'important');
      s.setProperty('overflow', 'visible', 'important');
      s.setProperty('visibility', 'visible', 'important');
      s.setProperty('opacity', '1', 'important');
      if (cs.clipPath && cs.clipPath !== 'none') s.setProperty('clip-path', 'none', 'important');
    };
    document.querySelectorAll('[data-ss-clicked][aria-controls], [aria-expanded][aria-controls]').forEach((t) => {
      if (t.closest('header, nav, [role="navigation"], [role="menu"]')) return;
      if (t.getAttribute('aria-haspopup') && t.getAttribute('aria-haspopup') !== 'false') return;
      t.getAttribute('aria-controls').split(/\s+/).forEach((id) => show(document.getElementById(id)));
      t.setAttribute('aria-expanded', 'true');
    });
    document.querySelectorAll('.collapse:not(.show), .accordion-collapse:not(.show)').forEach((c) => {
      if (c.closest('header, nav, .navbar')) return;
      c.classList.add('show');
      show(c);
    });
    document.querySelectorAll('details').forEach((d) => { d.open = true; });
  }).catch(() => {});
  await page.waitForTimeout(300);
}

// Scrolls the whole page so lazy-loaded images and scroll-triggered content render.
async function loadLazyContent(page) {
  await page.evaluate(async () => {
    document.querySelectorAll('img[loading="lazy"]').forEach((i) => { i.loading = 'eager'; });
    document.querySelectorAll('img[data-src]:not([src]), img[data-src][src*="data:"]').forEach((i) => { i.src = i.dataset.src; });
    const step = Math.max(300, Math.floor(window.innerHeight * 0.8));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let y = 0;
    for (let i = 0; i < 200; i++) {
      const max = document.documentElement.scrollHeight;
      if (y >= max) break;
      window.scrollTo(0, y);
      await sleep(120);
      y += step;
    }
    window.scrollTo(0, 0);
    // Reveal "animate on scroll" elements that might still be invisible.
    document.querySelectorAll('[data-aos], .aos-init, .wow, .reveal, .fade-in, [class*="animate__"]').forEach((el) => {
      el.style.setProperty('opacity', '1', 'important');
      el.style.setProperty('transform', 'none', 'important');
      el.style.setProperty('visibility', 'visible', 'important');
    });
    const imgs = [...document.images].filter((i) => !i.complete);
    await Promise.race([
      Promise.all(imgs.map((i) => new Promise((r) => { i.onload = i.onerror = r; }))),
      sleep(6000),
    ]);
  }).catch(() => {});
  await page.waitForTimeout(300);
}

async function getTabs(page) {
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll('[role="tablist"]').forEach((list, li) => {
      if (list.closest('header, nav, [role="navigation"]')) return;
      const r = list.getBoundingClientRect();
      if (!r.width || !r.height) return;
      list.querySelectorAll('[role="tab"]').forEach((tab, ti) => {
        tab.dataset.ssTab = `${li}-${ti}`;
        out.push({
          id: `${li}-${ti}`,
          selected: tab.getAttribute('aria-selected') === 'true',
          text: (tab.innerText || tab.getAttribute('aria-label') || `Tab ${ti + 1}`).trim().replace(/\s+/g, ' ').slice(0, 40),
        });
      });
    });
    return out;
  }).catch(() => []);
}

// ---------- Image post-processing ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function wrapUrl(url, maxChars) {
  const lines = [];
  let rest = url;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('/', maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    else cut += 1;
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  lines.push(rest);
  return lines;
}

// Adds a dark header band above the screenshot with the page number, title and full URL.
async function addUrlBand(buf, { url, label, scale }) {
  const { width } = await sharp(buf).metadata();
  const s = scale;
  const pad = Math.round(20 * s);
  const urlSize = 16 * s;
  const labelSize = 12 * s;
  const maxChars = Math.max(20, Math.floor((width - pad * 2) / (urlSize * 0.62)));
  const urlLines = wrapUrl(url, maxChars);
  const lineH = urlSize * 1.35;
  const height = Math.round(pad + labelSize + 10 * s + urlLines.length * lineH + pad * 0.6);
  const urlText = urlLines.map((l, i) =>
    `<text x="${pad}" y="${pad + labelSize + 10 * s + urlSize + i * lineH}" font-family="Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="${urlSize}" fill="#ffffff">${esc(l)}</text>`).join('');
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#14171c"/>
    <rect y="${height - Math.round(3 * s)}" width="100%" height="${Math.round(3 * s)}" fill="#f5b83d"/>
    <text x="${pad}" y="${pad + labelSize * 0.8}" font-family="Helvetica, Arial, sans-serif" font-size="${labelSize}" fill="#a3acb8">${esc(label)}</text>
    ${urlText}
  </svg>`;
  const out = await sharp(buf)
    .extend({ top: height, background: '#14171c' })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { buffer: out, bandHeight: height };
}

// ---------- PDF ----------

async function buildPdf(entries, pdfPath, pageWidthPt) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const MAX_PT = 14000; // PDF viewers cap page height around 14,400pt

  for (const e of entries) {
    const meta = await sharp(e.rawPath).metadata();
    const ratio = pageWidthPt / meta.width;
    const bandProbe = await addUrlBand(await sharp({ create: { width: meta.width, height: 1, channels: 3, background: '#fff' } }).png().toBuffer(), { url: e.url, label: e.label, scale: e.scale });
    const bandPx = bandProbe.bandHeight;
    const maxBodyPx = Math.floor(MAX_PT / ratio) - bandPx;
    const chunks = Math.max(1, Math.ceil(meta.height / maxBodyPx));

    for (let c = 0; c < chunks; c++) {
      const top = c * maxBodyPx;
      const h = Math.min(maxBodyPx, meta.height - top);
      const slice = await sharp(e.rawPath).extract({ left: 0, top, width: meta.width, height: h }).png().toBuffer();
      const label = chunks > 1 ? `${e.label}  ·  part ${c + 1} of ${chunks}` : e.label;
      const { buffer, bandHeight } = await addUrlBand(slice, { url: e.url, label, scale: e.scale });
      const jpg = await sharp(buffer).flatten({ background: '#ffffff' }).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
      const img = await doc.embedJpg(jpg);
      const w = pageWidthPt;
      const hPt = img.height * ratio;
      const page = doc.addPage([w, hPt]);
      page.drawImage(img, { x: 0, y: 0, width: w, height: hPt });

      // Make the header band clickable so reviewers can jump straight to the live page.
      const bandPt = bandHeight * ratio;
      const link = doc.context.obj({
        Type: 'Annot', Subtype: 'Link', Border: [0, 0, 0],
        Rect: [0, hPt - bandPt, w, hPt],
        A: { Type: 'Action', S: 'URI', URI: PDFString.of(e.url) },
      });
      page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(link)]));
    }
  }
  if (!entries.length) {
    const p = doc.addPage([612, 200]);
    p.drawText('No pages were captured.', { x: 40, y: 100, size: 14, font, color: rgb(0.2, 0.2, 0.2) });
  }
  fs.writeFileSync(pdfPath, await doc.save());
}

// ---------- Page discovery ----------

// Finds the pages a capture would include, without screenshotting anything:
// sitemap first, then a quick browser crawl that skips images, fonts and media.
// Emits { type: 'found', url, title, status, note } per page and returns
// { url, pages: [{ url, title, status, note }], truncated }.
async function discoverPages(job, emit) {
  const opts = job.options;
  const log = (msg) => emit({ type: 'log', msg });
  const root = normalizeUrl(opts.url, undefined, opts);
  if (!root) throw new Error('That URL does not look valid.');
  const authHeader = opts.authUser ? 'Basic ' + Buffer.from(`${opts.authUser}:${opts.authPass || ''}`).toString('base64') : null;

  const queue = [];
  const seen = new Set();
  const enqueue = (raw, base) => {
    const u = normalizeUrl(raw, base, opts);
    if (!u || !inScope(u, root, opts) || seen.has(u.href)) return;
    if (seen.size >= opts.maxPages * 5) return;
    seen.add(u.href);
    queue.push({ url: u.href, from: base && base !== u.href ? base : '' });
  };
  enqueue(root.href);
  if (opts.useSitemap) (await discoverSitemap(root, authHeader, log)).forEach((l) => enqueue(l, root.href));

  log('Opening the site to follow its links');
  const browser = await launchBrowser();
  job.browser = browser;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    httpCredentials: opts.authUser ? { username: opts.authUser, password: opts.authPass || '' } : undefined,
    ignoreHTTPSErrors: true,
  });
  await context.route('**/*', (route) => (['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue()));

  const pages = [];
  const found = new Set();
  let active = 0;
  let truncated = false;

  async function visit(item) {
    const page = await context.newPage();
    try {
      const resp = await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
      const status = resp ? resp.status() : 0;
      const ctype = resp ? (resp.headers()['content-type'] || '') : '';
      if (ctype && !ctype.includes('html')) return;
      const finalUrl = normalizeUrl(page.url(), undefined, opts);
      if (!finalUrl || !inScope(finalUrl, root, opts) || found.has(finalUrl.href)) return;
      if (pages.length >= opts.maxPages) { truncated = true; return; }
      found.add(finalUrl.href);
      seen.add(finalUrl.href);
      const entry = {
        url: finalUrl.href,
        title: (await page.title().catch(() => '')).trim(),
        status,
        note: status >= 400 ? `HTTP ${status}` + (item.from ? `, linked from ${item.from}` : '') : '',
      };
      pages.push(entry);
      emit({ type: 'found', ...entry, count: pages.length });
      const links = await page.$$eval('a[href]', (as) => as.map((a) => a.href)).catch(() => []);
      links.forEach((l) => enqueue(l, page.url()));
    } catch (err) {
      if (!found.has(item.url) && pages.length < opts.maxPages) {
        found.add(item.url);
        const entry = { url: item.url, title: '', status: 0, note: explainPageError(err.message) };
        pages.push(entry);
        emit({ type: 'found', ...entry, count: pages.length });
      }
    } finally {
      await page.close().catch(() => {});
    }
  }

  await new Promise((resolve) => {
    const pump = () => {
      if (job.cancelled && active === 0) return resolve();
      while (!job.cancelled && active < 4 && queue.length && pages.length + active < opts.maxPages) {
        const item = queue.shift();
        active++;
        visit(item).finally(() => { active--; pump(); });
      }
      if (queue.length && pages.length >= opts.maxPages) truncated = true;
      if (active === 0 && (!queue.length || pages.length >= opts.maxPages || job.cancelled)) resolve();
    };
    pump();
  });

  await browser.close().catch(() => {});
  job.browser = null;
  if (job.cancelled) throw new Error('Cancelled');
  if (!pages.length) {
    const e = new Error('No pages found.');
    e.problem = nothingCapturedProblem([]);
    e.problem.title = 'No pages found';
    e.problem.message = 'The site could not be opened in the browser, so there is nothing to capture.';
    throw e;
  }
  if (truncated) log(`Stopped at the ${opts.maxPages}-page limit (the site has more pages)`);
  // Home page first, then by address, so the review list (and the zip numbering) reads like a site map.
  const key = (p) => (p.url === root.href ? '' : new URL(p.url).pathname.toLowerCase() + new URL(p.url).search);
  pages.sort((a, b) => key(a).localeCompare(key(b)));
  return { url: root.href, pages, truncated };
}

// ---------- Main job ----------

async function runJob(job, emit) {
  const opts = job.options;
  const log = (msg) => emit({ type: 'log', msg });
  const root = normalizeUrl(opts.url, undefined, opts);
  if (!root) throw new Error('That URL does not look valid.');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-snapper-'));
  const rawDir = path.join(workDir, 'raw');
  fs.mkdirSync(rawDir);
  const authHeader = opts.authUser ? 'Basic ' + Buffer.from(`${opts.authUser}:${opts.authPass || ''}`).toString('base64') : null;
  const viewports = opts.viewports.map((v) => [v, VIEWPORTS[v]]).filter(([, v]) => v);
  const captured = new Date();
  const dateLabel = captured.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  log(`Starting ${root.href}`);
  const queue = [];
  const seen = new Set();
  const enqueue = (raw, base) => {
    const u = normalizeUrl(raw, base, opts);
    if (!u || !inScope(u, root, opts) || seen.has(u.href)) return;
    if (seen.size >= opts.maxPages * 3) return;
    seen.add(u.href);
    queue.push({ url: u.href, order: seen.size, from: base && base !== u.href ? base : '' });
  };
  if (opts.urls) {
    // Capture exactly the pages the person confirmed, in the order they were found.
    opts.urls.forEach((u) => enqueue(u));
    log(`Capturing ${queue.length} confirmed page${queue.length === 1 ? '' : 's'}`);
  } else {
    enqueue(root.href);
    if (opts.useSitemap) (await discoverSitemap(root, authHeader, log)).forEach((l) => enqueue(l, root.href));
  }

  log('Starting the screenshot browser');
  const browser = await launchBrowser();
  job.browser = browser;

  const contexts = {};
  for (const [key, v] of viewports) {
    contexts[key] = await browser.newContext({
      viewport: { width: v.width, height: v.height },
      deviceScaleFactor: v.scale,
      isMobile: v.mobile,
      hasTouch: v.mobile,
      userAgent: v.ua,
      httpCredentials: opts.authUser ? { username: opts.authUser, password: opts.authPass || '' } : undefined,
      ignoreHTTPSErrors: true,
      reducedMotion: 'reduce',
    });
  }

  const results = []; // { order, url, title, status, shots: [{viewport, variant, rawPath, scale}] }
  const failures = []; // { url, note } for pages that produced no screenshot
  const doneUrls = new Set();
  let pagesDone = 0;
  let active = 0;

  async function capturePage(item) {
    const pageResult = { order: item.order, url: item.url, title: '', status: '', shots: [], note: '' };
    for (const [vKey, v] of viewports) {
      if (job.cancelled) return;
      const page = await contexts[vKey].newPage();
      try {
        const resp = await page.goto(item.url, { waitUntil: 'load', timeout: 45000 });
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        const finalUrl = normalizeUrl(page.url(), undefined, opts);
        const status = resp ? resp.status() : 0;
        const ctype = resp ? (resp.headers()['content-type'] || '') : '';

        if (vKey === viewports[0][0]) {
          pageResult.status = status;
          if (finalUrl && finalUrl.href !== item.url) {
            if (!inScope(finalUrl, root, opts)) { pageResult.note = `Redirects off-site to ${finalUrl.href}`; pageResult.skip = true; }
            else if (doneUrls.has(finalUrl.href) || seen.has(finalUrl.href) && finalUrl.href !== item.url) {
              pageResult.note = `Redirects to ${finalUrl.href}`; pageResult.skip = true;
            }
          }
          if (ctype && !ctype.includes('html')) { pageResult.note = `Not a web page (${ctype.split(';')[0]})`; pageResult.skip = true; }
          if (pageResult.skip) return;
          if (finalUrl) { pageResult.url = finalUrl.href; pageResult.displayUrl = (() => { const d = new URL(page.url()); d.hash = ''; if (!opts.keepQuery) d.search = ''; return d.href; })(); doneUrls.add(finalUrl.href); seen.add(finalUrl.href); }
          pageResult.title = (await page.title().catch(() => '')).trim();
          if (status >= 400) pageResult.note = `HTTP ${status}` + (item.from ? `, linked from ${item.from}` : '');

          // Discover more links from this page (not needed when capturing a confirmed list).
          if (!opts.urls) {
            const links = await page.$$eval('a[href]', (as) => as.map((a) => a.href)).catch(() => []);
            links.forEach((l) => enqueue(l, page.url()));
          }
        }

        await page.addStyleTag({ content: KILL_MOTION_CSS }).catch(() => {});
        if (opts.dismissCookies) await dismissCookieBanners(page);
        await loadLazyContent(page);
        if (opts.expand) await expandEverything(page);
        await page.waitForTimeout(250);

        const base = path.join(rawDir, `${String(item.order).padStart(4, '0')}-${vKey}`);
        await page.screenshot({ path: `${base}-main.png`, fullPage: true, timeout: 90000 });
        pageResult.shots.push({ viewport: vKey, variant: '', rawPath: `${base}-main.png`, scale: v.scale });

        if (opts.captureTabs) {
          const tabs = (await getTabs(page)).filter((t) => !t.selected).slice(0, 12);
          for (const [i, t] of tabs.entries()) {
            const el = await page.$(`[data-ss-tab="${t.id}"]`);
            if (!el) continue;
            await el.click({ timeout: 3000 }).catch(() => el.evaluate((n) => n.click()).catch(() => {}));
            await page.waitForTimeout(500);
            await loadLazyContent(page);
            if (opts.expand) await expandEverything(page);
            const p = `${base}-tab${i}.png`;
            await page.screenshot({ path: p, fullPage: true, timeout: 90000 });
            pageResult.shots.push({ viewport: vKey, variant: `Tab: ${t.text}`, rawPath: p, scale: v.scale, tabText: t.text });
          }
        }
      } catch (err) {
        pageResult.note = (pageResult.note ? pageResult.note + '; ' : '') + `${v.label}: ${explainPageError(err.message)}`;
      } finally {
        await page.close().catch(() => {});
      }
    }
    return pageResult;
  }

  await new Promise((resolve) => {
    const pump = () => {
      if (job.cancelled && active === 0) return resolve();
      while (!job.cancelled && active < opts.concurrency && queue.length && pagesDone + active < opts.maxPages) {
        const item = queue.shift();
        active++;
        emit({ type: 'page-start', url: item.url });
        capturePage(item).then((r) => {
          active--;
          if (r) {
            if (!r.skip && r.shots.length) { results.push(r); pagesDone++; }
            else if (!r.skip) failures.push({ url: r.url, note: r.note || 'no screenshot taken' });
            emit({
              type: 'page-done', url: r.url, title: r.title, status: r.status,
              shots: r.shots.length, skipped: !!r.skip, failed: !r.skip && !r.shots.length, note: r.note,
              done: pagesDone, queued: Math.min(opts.maxPages, pagesDone + active + queue.length),
            });
          }
          pump();
        }).catch((err) => {
          active--;
          const note = explainPageError(err.message);
          failures.push({ url: item.url, note });
          emit({ type: 'page-done', url: item.url, shots: 0, note, failed: true, done: pagesDone, queued: Math.min(opts.maxPages, pagesDone + active + queue.length) });
          pump();
        });
      }
      if (active === 0 && (!queue.length || pagesDone >= opts.maxPages)) resolve();
    };
    pump();
  });

  await browser.close().catch(() => {});
  job.browser = null;
  if (job.cancelled) {
    fs.rmSync(workDir, { recursive: true, force: true });
    throw new Error('Cancelled');
  }
  if (!results.length) {
    const e = new Error('No pages could be captured.');
    e.problem = nothingCapturedProblem(failures);
    throw e;
  }
  if (queue.length && pagesDone >= opts.maxPages) log(`Stopped at the ${opts.maxPages}-page limit (more pages were found)`);

  // ---------- Package ----------
  emit({ type: 'packaging', msg: 'Stamping URLs and building the zip' });
  results.sort((a, b) => a.order - b.order);
  const siteName = hostKey(root);
  const stamp = captured.toISOString().slice(0, 10);
  const bundleName = `${siteName}-screenshots-${stamp}`;
  const outDir = path.join(workDir, bundleName);
  fs.mkdirSync(outDir);

  const manifest = [['#', 'Page title', 'URL', 'HTTP status', 'Viewport', 'Variant', 'File', 'Notes']];
  const pdfEntries = {};
  const usedSlugs = new Map();

  for (const [i, r] of results.entries()) {
    const num = String(i + 1).padStart(3, '0');
    let slug = slugFor(new URL(r.url));
    const count = usedSlugs.get(slug) || 0;
    usedSlugs.set(slug, count + 1);
    if (count) slug += `-${count + 1}`;
    r.num = num;

    for (const shot of r.shots) {
      const v = VIEWPORTS[shot.viewport];
      const folder = viewports.length > 1 ? v.label.toLowerCase() : '';
      const tabIdx = r.shots.filter((s) => s.viewport === shot.viewport && s.variant).indexOf(shot);
      const variantSlug = shot.variant ? `--tab-${tabIdx + 2}-${shot.tabText.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)}` : '';
      const fileName = `${num}-${slug}${variantSlug}.png`;
      const rel = folder ? `${folder}/${fileName}` : fileName;
      const label = [`#${num}`, r.status >= 400 ? `HTTP ${r.status}` : '', r.title || '(untitled)', shot.variant, `${v.label} ${v.width}px`, dateLabel].filter(Boolean).join('  ·  ');

      const shownUrl = r.displayUrl || r.url;
      const { buffer } = await addUrlBand(fs.readFileSync(shot.rawPath), { url: shownUrl, label, scale: shot.scale });
      fs.mkdirSync(path.join(outDir, folder), { recursive: true });
      fs.writeFileSync(path.join(outDir, rel), buffer);
      manifest.push([num, r.title, shownUrl, r.status, v.label, shot.variant, rel, r.note]);
      (pdfEntries[shot.viewport] ||= []).push({ rawPath: shot.rawPath, url: shownUrl, label, scale: shot.scale });
    }
    emit({ type: 'packaging', msg: `Stamped ${i + 1} of ${results.length} pages` });
  }

  const csv = manifest.map((row) => row.map((c) => {
    const s = String(c ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  fs.writeFileSync(path.join(outDir, 'manifest.csv'), '﻿' + csv);

  if (opts.pdf) {
    for (const [vKey, entries] of Object.entries(pdfEntries)) {
      emit({ type: 'packaging', msg: `Building ${VIEWPORTS[vKey].label.toLowerCase()} review PDF` });
      await buildPdf(entries, path.join(outDir, `review-${vKey}.pdf`), vKey === 'mobile' ? 390 : 720);
    }
  }

  const zipPath = path.join(workDir, `${bundleName}.zip`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    const zip = archiver('zip', { zlib: { level: 6 } });
    out.on('close', resolve);
    zip.on('error', reject);
    zip.pipe(out);
    zip.directory(outDir, bundleName);
    zip.finalize();
  });

  // Keep a copy in ./output so nothing is lost if the browser tab closes.
  let keptZip = zipPath;
  try {
    const keepDir = path.join(__dirname, '..', 'output');
    fs.mkdirSync(keepDir, { recursive: true });
    keptZip = path.join(keepDir, `${bundleName}.zip`);
    fs.copyFileSync(zipPath, keptZip);
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    keptZip = zipPath; // read-only disk: serve the zip from the temp folder instead
  }

  return {
    zipPath: keptZip,
    fileName: `${bundleName}.zip`,
    pages: results.length,
    screenshots: manifest.length - 1,
    sizeMB: +(fs.statSync(keptZip).size / 1048576).toFixed(1),
  };
}

module.exports = { runJob, discoverPages, checkBrowser, VIEWPORTS };
