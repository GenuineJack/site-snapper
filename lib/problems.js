// Turns raw errors into plain-English "problems" the page can show:
// { code, title, message, steps: [..], details, blocking }
// Steps may contain `backticks`, which the page renders as copyable commands.

const SERVERLESS_HOSTS = [
  ['VERCEL', 'Vercel'],
  ['NETLIFY', 'Netlify'],
  ['AWS_LAMBDA_FUNCTION_NAME', 'AWS Lambda'],
  ['CF_PAGES', 'Cloudflare Pages'],
];

function serverlessHost() {
  const hit = SERVERLESS_HOSTS.find(([env]) => process.env[env]);
  return hit ? hit[1] : null;
}

const RUN_LOCALLY_STEPS = [
  'Install Node.js 18 or newer from https://nodejs.org (the LTS version is fine).',
  'Download this project (GitHub → Code → Download ZIP) and unzip it, or `git clone` it.',
  'Open Terminal in the project folder and run `npm install` (one time; this also downloads the screenshot browser).',
  'Run `npm start`. Site Snapper opens at http://localhost:4321.',
];

function problem(code, title, message, steps = [], details = '', extra = {}) {
  return { code, title, message, steps, details: details ? String(details) : '', ...extra };
}

function serverlessProblem(host, details) {
  return problem(
    'serverless-host',
    `Site Snapper can't take screenshots on ${host}`,
    `Site Snapper drives a real Chrome browser to open every page and screenshot it. ${host} runs code as short-lived serverless functions: there is no browser installed, each request is cut off after a few minutes, and nothing is kept between requests. So the capture can't start here. Nothing is wrong with your site or with the URL you entered. The easiest fix is to run it on your own computer, which takes about two minutes:`,
    [
      ...RUN_LOCALLY_STEPS,
      'Prefer a link you can open from anywhere? Host it on a service that runs a normal, always-on server (Railway, Render or Fly.io). The project includes a Dockerfile that sets everything up; see "Put it online" in the README.',
    ],
    details,
    { blocking: true },
  );
}

// Errors from launching the headless browser.
function explainLaunchError(err) {
  const msg = String((err && err.message) || err);
  const host = serverlessHost();
  if (host) return serverlessProblem(host, msg);

  if (/Executable doesn't exist|browserType\.launch.*ENOENT|Failed to launch.*no such file/i.test(msg)) {
    return problem(
      'browser-missing',
      "Site Snapper can't find a Chrome browser",
      'Site Snapper needs Chrome to open and screenshot pages. It looked for its own downloaded copy, then for Google Chrome and Microsoft Edge on this computer, and found none of them.',
      [
        'Install Google Chrome from https://www.google.com/chrome (the normal version is fine).',
        'Come back to this page and click "Check again". No restart needed.',
        'Rather not use your own Chrome? Run `npx playwright install chromium` in the site-snapper folder instead.',
      ],
      msg,
      { blocking: true },
    );
  }
  if (/missing dependencies|error while loading shared libraries|libnss3|libatk/i.test(msg)) {
    return problem(
      'browser-deps',
      "Chrome can't start on this machine",
      'The screenshot browser is installed, but this computer or server is missing system libraries Chrome needs (common on bare Linux servers).',
      [
        'On Linux, run `sudo npx playwright install-deps chromium`, then try again.',
        'If this is a hosted server, deploy with the included Dockerfile instead. It installs everything Chrome needs.',
      ],
      msg,
      { blocking: true },
    );
  }
  return problem(
    'browser-launch',
    "The screenshot browser wouldn't start",
    'Site Snapper could not open its headless Chrome.',
    [
      'Run `npx playwright install chromium` in the site-snapper folder, then click "Check again".',
      'If you are low on memory, close other apps and try again.',
      'Still stuck? Copy the technical details below into a GitHub issue.',
    ],
    msg,
    { blocking: true },
  );
}

// Errors from checking that the site is reachable before the crawl starts.
function explainFetchError(err, url) {
  const code = (err && err.cause && err.cause.code) || (err && err.code) || '';
  const name = (err && err.name) || '';
  const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
  const details = [code, (err && err.cause && err.cause.message) || (err && err.message)].filter(Boolean).join(': ');

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return problem('site-not-found', `Couldn't find ${host}`, `No website answered at ${host}. The address may be misspelled, or the domain isn't set up yet.`,
      ['Check the spelling of the address.', 'Open it in your own browser to make sure it loads.', 'If you are offline or on a VPN, reconnect and try again.'], details);
  }
  if (code === 'ECONNREFUSED') {
    return problem('site-refused', `${host} refused the connection`, 'The server exists but is not accepting web traffic right now.',
      ['Open the address in your browser to check the site is up.', 'If it is a local or staging site, make sure it is running.'], details);
  }
  if (name === 'TimeoutError' || name === 'AbortError' || /TIMEOUT/i.test(code)) {
    return problem('site-timeout', `${host} took too long to respond`, 'The site did not answer within 15 seconds.',
      ['Open the address in your browser to check it loads.', 'Try again in a minute; the site may be slow or temporarily down.'], details);
  }
  if (/CERT|SSL|TLS|SELF_SIGNED/i.test(code)) {
    return problem('site-cert', `${host} has a security certificate problem`, 'The site\'s HTTPS certificate could not be verified, and it did not respond over plain HTTP either.',
      ['Open the address in your browser; if it shows a security warning, the site owner needs to fix the certificate.'], details);
  }
  return problem('site-unreachable', `Couldn't reach ${host}`, 'Site Snapper could not connect to this site.',
    ['Open the address in your browser to make sure it loads.', 'Check your internet connection and try again.'], details || String(err));
}

// Short, friendly notes for a single page that failed during the crawl.
function explainPageError(msg) {
  const m = String(msg || '');
  if (/ERR_NAME_NOT_RESOLVED/.test(m)) return "couldn't find this address";
  if (/ERR_CONNECTION_REFUSED/.test(m)) return 'server refused the connection';
  if (/ERR_CONNECTION_(RESET|CLOSED)|ERR_EMPTY_RESPONSE/.test(m)) return 'server dropped the connection';
  if (/ERR_TOO_MANY_REDIRECTS/.test(m)) return 'redirect loop';
  if (/ERR_CERT|ERR_SSL/.test(m)) return 'security certificate problem';
  if (/ERR_ABORTED|Download is starting/.test(m)) return 'link is a file download, not a page';
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/.test(m)) return 'lost internet connection';
  const t = m.match(/Timeout (\d+)ms exceeded/);
  if (t) return `page took longer than ${Math.round(t[1] / 1000)}s to load`;
  if (/Target (page|closed)|browser has been closed/i.test(m)) return 'browser closed before the page finished';
  return m.split('\n')[0];
}

function nothingCapturedProblem(failures) {
  const first = failures[0];
  return problem(
    'nothing-captured',
    'No pages could be captured',
    first
      ? `The site loaded in the browser but every page failed. The first one said: "${first.note}".`
      : 'The crawl finished without capturing any pages.',
    [
      'Open the address in your own browser to make sure it loads.',
      'If the site asks for a username and password, fill them in under "More options".',
      'If you ticked "Only pages under this URL\'s path" or added "Skip URLs", loosen those and try again.',
    ],
    failures.slice(0, 10).map((f) => `${f.url}: ${f.note}`).join('\n'),
  );
}

function genericProblem(err) {
  return problem(
    'unexpected',
    'Something went wrong',
    'Site Snapper hit an unexpected error.',
    ['Try again.', 'If it keeps happening, copy the technical details below into a GitHub issue.'],
    (err && (err.stack || err.message)) || String(err),
  );
}

module.exports = {
  serverlessHost, serverlessProblem, explainLaunchError, explainFetchError, explainPageError,
  nothingCapturedProblem, genericProblem, problem,
};
