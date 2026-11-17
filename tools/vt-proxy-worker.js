/*
 * VirusTotal CORS proxy for File Object Browser, as a Cloudflare Worker (the free plan is enough).
 *
 * Why it exists: VirusTotal's API sends no CORS headers, so a page on
 * github.io cannot read its responses. This worker forwards exactly one kind of
 * request, GET /files/<md5|sha1|sha256>, to the VirusTotal v3 file-report
 * endpoint and adds CORS headers for the origins you allow. It cannot be used
 * as a general open proxy, and it never sees file contents, only hashes.
 *
 * Deploy:
 *   1. dash.cloudflare.com → Workers & Pages → Create → "Hello World" worker →
 *      Edit code → paste this file → Deploy.
 *   2. Settings → Variables:
 *        ALLOWED_ORIGINS = https://<you>.github.io,http://localhost:8000
 *      Optional: VT_API_KEY (secret). If it is set, browsers do not need to send a
 *      key, but then anyone who can load your FOB page can spend your quota.
 *      Leaving it unset means every user enters their own key in FOB.
 *   3. In FOB: Tools → Lookup settings → paste the worker URL
 *      (https://<name>.<you>.workers.dev) and your VirusTotal API key.
 *
 * With Wrangler instead: `npx wrangler deploy tools/vt-proxy-worker.js --name fob-vt`.
 */
const HASH = /^\/files\/([0-9a-fA-F]{32}|[0-9a-fA-F]{40}|[0-9a-fA-F]{64})\/?$/;

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = String((env && env.ALLOWED_ORIGINS) || '')
      .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
    const ok = allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': ok ? origin : 'null',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'x-apikey',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const json = (status, code, message) => new Response(JSON.stringify({ error: { code, message } }), {
      status, headers: { ...cors, 'content-type': 'application/json' },
    });

    if (!ok) return json(403, 'OriginNotAllowed', `Origin "${origin}" is not in ALLOWED_ORIGINS`);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'GET') return json(405, 'MethodNotAllowed', 'Only GET is supported');

    const m = HASH.exec(new URL(req.url).pathname);
    if (!m) return json(404, 'NotFound', 'Use GET /files/<md5|sha1|sha256>');

    const key = req.headers.get('x-apikey') || (env && env.VT_API_KEY);
    if (!key) return json(401, 'NoApiKey', 'Send x-apikey, or set VT_API_KEY on the worker');

    const upstream = await fetch(`https://www.virustotal.com/api/v3/files/${m[1].toLowerCase()}`, {
      headers: { 'x-apikey': key, accept: 'application/json' },
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors, 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'private, max-age=300' },
    });
  },
};
