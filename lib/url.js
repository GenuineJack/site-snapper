// Turns whatever someone pastes ("jackdemanche.com", "www.site.com/about",
// "https//site.com", "HTTP://Site.com/") into a real starting URL, then checks
// which variant actually answers: https or http, with or without www.

const { problem, explainFetchError } = require('./problems');

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function invalid(input, message, steps) {
  return problem('bad-url', "That doesn't look like a web address", message,
    steps || ['Type or paste the site address, for example `example.com` or `https://www.example.com/about`.'],
    `You entered: ${input}`);
}

// Returns { url: URL, hadScheme: bool } or { problem }.
function parseUserUrl(input) {
  let s = String(input || '').trim();
  if (!s) return { problem: problem('empty-url', 'Paste a URL to start', 'Enter the address of the site you want to capture.', ['For example `example.com` or `https://www.example.com`.']) };

  // Strip wrapping quotes/brackets and trailing punctuation from copy-paste, plus stray spaces.
  s = s.replace(/^[<"'`\s]+|[>"'`\s]+$/g, '').replace(/[.,;]+$/, '').replace(/\s+/g, '');

  // Repair common scheme typos: "https//", "https:/", "http;//", "htps://", "hhttp://".
  let hadScheme = false;
  let scheme = 'https:';
  const m = s.match(/^([a-z]+)(?::\/*|;\/*|\/\/+)/i);
  if (m && /^h*t+p+s?$/i.test(m[1])) {
    hadScheme = true;
    scheme = /s$/i.test(m[1]) ? 'https:' : 'http:';
    s = s.slice(m[0].length);
  } else if (m && /^[a-z]+$/i.test(m[1]) && s[m[1].length] === ':' && !/^\d/.test(s.slice(m[1].length + 1))) {
    return { problem: invalid(input, `Site Snapper captures web pages, so the address needs to be a website, not a "${m[1]}:" link.`) };
  } else if (s.startsWith('//')) {
    s = s.replace(/^\/+/, '');
  }

  let u;
  try { u = new URL(`${scheme}//${s}`); } catch { return { problem: invalid(input, 'Site Snapper couldn\'t make sense of that address.') }; }

  const host = u.hostname;
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
  if (!isIp && host !== 'localhost' && !host.includes('.')) {
    return { problem: invalid(input, `"${host}" is missing its ending, like .com or .org.`, [`Did you mean \`${host}.com\`? Add the full domain and try again.`]) };
  }
  if (!isIp && host !== 'localhost' && !/\.[a-z][a-z0-9-]*$/i.test(host) && !/^xn--/i.test(host.split('.').pop())) {
    return { problem: invalid(input, `"${host}" doesn't end in a valid domain like .com or .org.`) };
  }
  u.hash = '';
  return { url: u, hadScheme };
}

// Build the list of variants to try, most likely first.
function candidates(u, hadScheme) {
  const out = [];
  const add = (proto, host) => {
    const c = new URL(u.href);
    c.protocol = proto;
    c.hostname = host;
    if (!out.some((x) => x.href === c.href)) out.push(c);
  };
  const host = u.hostname;
  const isName = /[a-z]/i.test(host) && host !== 'localhost' && !host.startsWith('[');
  const other = !isName ? null : host.startsWith('www.') ? host.slice(4) : host.split('.').length === 2 ? `www.${host}` : null;
  // Real domains almost always serve https; local dev servers and bare IPs usually don't.
  const protos = hadScheme ? [u.protocol, u.protocol === 'https:' ? 'http:' : 'https:'] : isName ? ['https:', 'http:'] : ['http:', 'https:'];
  for (const p of protos) {
    add(p, host);
    if (other) add(p, other);
  }
  return out;
}

async function probe(url, authHeader) {
  const headers = { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
  if (authHeader) headers.Authorization = authHeader;
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  res.body?.cancel().catch(() => {});
  return res;
}

// Returns { url: string, notes: [..] } or { problem }.
async function resolveStartUrl(input, { authHeader } = {}) {
  const parsed = parseUserUrl(input);
  if (parsed.problem) return parsed;

  const tries = candidates(parsed.url, parsed.hadScheme);
  let firstErr = null;
  for (const c of tries) {
    let res;
    try { res = await probe(c.href, authHeader); } catch (err) { firstErr ||= err; continue; }

    const final = new URL(res.url || c.href);
    const notes = [];
    if (final.href.replace(/\/$/, '') !== String(input).trim().replace(/\/$/, '')) notes.push(`Using ${final.href}`);

    if (res.status === 401) {
      return { problem: problem('needs-login', 'This site needs a username and password',
        authHeader ? 'The username and password you entered were not accepted.' : 'The site asked for a login before showing any pages (common on staging sites).',
        ['Open "More options" below the address box.', 'Fill in the username and password you use to view the site, then try again.'],
        `HTTP 401 from ${final.href}`) };
    }
    if (res.status === 403 || res.status === 429 || res.status === 503) {
      notes.push(`The site answered HTTP ${res.status} to a quick check (often bot protection). Trying with the full browser anyway.`);
    } else if (res.status >= 400) {
      notes.push(`The start page returned HTTP ${res.status}. It will still be captured and flagged.`);
    }
    return { url: final.href, notes };
  }
  return { problem: explainFetchError(firstErr, tries[0].href) };
}

module.exports = { parseUserUrl, resolveStartUrl, candidates };
