// Downloads Playwright's copy of Chrome after `npm install`. This is a convenience,
// not a requirement: if it fails, Site Snapper falls back to the Google Chrome or
// Microsoft Edge already on the computer, so a failed download never breaks the install.
const { spawnSync } = require('child_process');

if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD || process.env.VERCEL) process.exit(0);

const r = spawnSync(process.execPath, [require('path').join(require('path').dirname(require.resolve('playwright/package.json')), 'cli.js'), 'install', 'chromium'], { stdio: 'inherit' });
if (r.status !== 0) {
  console.log('\n  Note: the Chrome download didn\'t finish. That\'s OK: Site Snapper will use');
  console.log('  Google Chrome or Microsoft Edge if one is installed on this computer.\n');
}
