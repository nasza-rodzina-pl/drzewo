// Serwer logowania dla drzewa (Cloudflare Worker).
// Wymienia jednorazowy kod z GitHuba na token użytkownika i odświeża token.
// Przechowuje tylko sekret aplikacji; tokenów nie zapisuje.
//
// Zmienne (Settings → Variables and secrets):
//   CLIENT_ID       Client ID aplikacji GitHub
//   CLIENT_SECRET   Client secret aplikacji GitHub (typ: Secret)
//   ALLOWED_ORIGIN  adres strony, np. https://nasza-rodzina-pl.github.io (kilka: po przecinku)

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!allowed.includes(origin)) return json({ error: 'forbidden_origin' }, 403);
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400, cors); }

    const params = { client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET };
    const { pathname } = new URL(request.url);
    if (pathname === '/token' && body.code) {
      Object.assign(params, { code: body.code, redirect_uri: body.redirect_uri, code_verifier: body.code_verifier });
    } else if (pathname === '/refresh' && body.refresh_token) {
      Object.assign(params, { grant_type: 'refresh_token', refresh_token: body.refresh_token });
    } else {
      return json({ error: 'bad_request' }, 400, cors);
    }

    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'drzewo-auth-worker' },
      body: JSON.stringify(params),
    });
    const data = await res.json().catch(() => ({ error: 'bad_github_response' }));
    return json(data, data.error ? 400 : 200, cors);
  },
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
