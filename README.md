# Site Snapper

Paste a URL and get back a zip with a full-page screenshot of every page on the site. Accordions and collapsed sections are opened first, and every screenshot has the page's URL stamped across the top so reviewers always know where a comment belongs.

Everything runs on your own computer. Nothing is uploaded anywhere.

> **Heads up: this doesn't work on Vercel (or Netlify, Cloudflare Pages, etc.).** Site Snapper drives a real Chrome browser for minutes at a time. Serverless hosts don't include a browser, cut requests off after a few minutes, and don't keep anything in memory between requests. Run it on your computer (below), or see [Put it online](#put-it-online) for hosts that do work. If you open a Vercel deployment, the page tells you this instead of failing.

## One-time setup

1. Install **Node.js 18 or newer** from https://nodejs.org (the LTS version is fine).
2. Unzip this folder somewhere handy, like Documents.
3. Open Terminal, go into the folder, and install:

   ```
   cd ~/Documents/site-snapper
   npm install
   ```

   This also tries to download a headless Chrome (about 150 MB, one time only). If that download fails, don't worry: Site Snapper uses the Google Chrome or Microsoft Edge already on your computer instead.

## Every time you use it

```
cd ~/Documents/site-snapper
npm start
```

Your browser opens to `http://localhost:4321`. Paste a URL, hit **Capture site**, and the zip downloads when it's done. Press `Ctrl+C` in Terminal to stop it.

You can type the address however you like: `example.com`, `www.example.com`, `http://example.com/about` and `https://www.example.com/` all work. Site Snapper tries https and http, with and without `www`, and follows redirects to find the version of the site that actually loads.

If something goes wrong, the page shows what happened and what to do about it, with the technical details and a full activity log underneath.

A copy of every zip is also kept in the `output` folder, so nothing is lost if you close the tab.

## What's in the zip

```
example.com-screenshots-2026-09-30/
  desktop/
    001-home.png
    002-about.png
    003-services.png
    003-services--tab-2-pricing.png
  mobile/                 (if you ticked Mobile)
  review-desktop.pdf      one page per screenshot, URL headers are clickable
  review-mobile.pdf
  manifest.csv            number, title, URL, status and file for every screenshot
```

Each screenshot has a dark header band with the page number, title, viewport, capture date and the full URL (long URLs wrap, they never get cut off). Numbers match across the PNGs, PDF and manifest, so a reviewer can say "#014, second paragraph" and everyone lands on the same page.

## Options

- **Desktop / Mobile**: 1440px desktop, 390px iPhone-size mobile. Tick both to get both folders.
- **Max pages**: safety cap so a big blog archive doesn't run forever.
- **Username / Password**: for staging sites behind a browser login prompt (HTTP basic auth).
- **Skip URLs containing**: e.g. `/tag/, /author/, /page/` to leave out archive pages.
- **Capture each tab state**: tabbed sections only show one panel at a time, so each extra tab gets its own screenshot.
- **Only pages under this URL's path**: paste `https://site.com/products/` to capture just that section.

## How pages are found

It reads `sitemap.xml` (and any sitemaps listed in `robots.txt`), then follows every internal link on each page it visits. It stays on the same domain, skips files like PDFs and images, and skips admin, cart and login pages.

Broken pages still get captured and are flagged in the header and manifest with their status (e.g. `HTTP 404`) plus the page that linked to them.

## Known limits

- Content behind a login form (not a browser login prompt) won't be reached.
- Carousels and sliders are captured on whatever slide is showing.
- Pop-ups that appear after a delay (newsletter sign-ups, chat widgets) may show up in some shots.
- Unusual custom accordions that don't use standard markup may stay closed. The common patterns (`<details>`, `aria-expanded` accordions, Bootstrap collapses) are covered.

## Put it online

To get a link you can open from anywhere (or share with your team), host it on a service that runs a normal, always-on server. No terminal needed: the included `Dockerfile` starts from Microsoft's official Playwright image, which already has Chrome and everything it needs.

**Railway** (simplest, all in the browser):

1. Go to https://railway.com/new and choose **Deploy from GitHub repo**.
2. Pick this repo. Railway reads `railway.json` and the `Dockerfile` and builds it (takes a few minutes the first time).
3. When it says *Active*, open the service → **Settings** → **Networking** → **Generate Domain**.
4. Open that link. That's Site Snapper.

Every push to the branch you deployed redeploys automatically.

**Render**: New → Web Service → connect this repo. Choose *Docker* as the runtime. Use an instance with at least 1 GB of memory; Chrome runs out of room on the 512 MB free tier.

**Fly.io**: `fly launch` in this folder, accept the detected Dockerfile, then `fly deploy`.

Hosted copies can't "Show in folder" (the button is hidden), but the zip still downloads. The `CONCURRENCY` setting (default 2 in Docker, 3 locally) controls how many pages load at once; lower it if the server runs out of memory.

Anyone with the link can use a hosted copy to crawl sites, so keep the URL private or put it behind your host's access controls.

## Troubleshooting

The page checks its setup when it loads and explains any problem with step-by-step fixes. The common ones:

- **"Can't find a Chrome browser"** (or `Executable doesn't exist`): install Google Chrome from https://www.google.com/chrome, then click **Check again**.
- **"Can't take screenshots on Vercel"**: see the note at the top of this README.
- **"Chrome can't start on this machine"** (Linux servers): run `sudo npx playwright install-deps chromium`, or deploy with the Dockerfile.
- **Port already in use**: `PORT=5000 npm start`.
- **Don't want the browser to open automatically**: `NO_OPEN=1 npm start`.
