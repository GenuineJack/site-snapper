# Site Snapper

Paste a URL and get back a zip with a full-page screenshot of every page on the site. Accordions and collapsed sections are opened first, and every screenshot has the page's URL stamped across the top so reviewers always know where a comment belongs.

Everything runs on your own computer. Nothing is uploaded anywhere.

## One-time setup

1. Install **Node.js 18 or newer** from https://nodejs.org (the LTS version is fine).
2. Unzip this folder somewhere handy, like Documents.
3. Open Terminal, go into the folder, and install:

   ```
   cd ~/Documents/site-snapper
   npm install
   ```

   This also downloads the headless Chrome it uses (about 150 MB, one time only).

## Every time you use it

```
cd ~/Documents/site-snapper
npm start
```

Your browser opens to `http://localhost:4321`. Paste a URL, hit **Capture site**, and the zip downloads when it's done. Press `Ctrl+C` in Terminal to stop it.

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

## Troubleshooting

- **"Executable doesn't exist" error**: run `npx playwright install chromium`.
- **Port already in use**: `PORT=5000 npm start`.
- **Don't want the browser to open automatically**: `NO_OPEN=1 npm start`.
