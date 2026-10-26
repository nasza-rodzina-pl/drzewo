// Logowanie przez GitHub (GitHub App, OAuth web flow z PKCE).
// Wymianę kodu na token robi mały serwer pośredniczący (auth-worker/), bo GitHub
// nie pozwala na to z przeglądarki (brak CORS) i wymaga sekretu aplikacji.

const KEY = 'family-tree:auth';
const FLOW = 'family-tree:oauth';
const MARGIN = 5 * 60 * 1000; // odśwież token 5 min przed wygaśnięciem

export class AuthError extends Error {}

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

function read() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } }
function write(a) { try { a ? localStorage.setItem(KEY, JSON.stringify(a)) : localStorage.removeItem(KEY); } catch {} }

function fromResponse(d) {
  const now = Date.now();
  return {
    access_token: d.access_token,
    expires_at: d.expires_in ? now + d.expires_in * 1000 : null,
    refresh_token: d.refresh_token || null,
    refresh_expires_at: d.refresh_token_expires_in ? now + d.refresh_token_expires_in * 1000 : null,
  };
}

const redirectUri = () => location.origin + location.pathname;

export class Auth {
  constructor({ clientId, authProxy }) {
    this.clientId = clientId;
    this.proxy = (authProxy || '').replace(/\/+$/, '');
    this.refreshing = null;
  }

  /** Przekierowuje na stronę logowania GitHuba. */
  async login() {
    if (!this.clientId || !this.proxy) throw new AuthError('Logowanie nie jest skonfigurowane — uzupełnij clientId i authProxy w config.js.');
    const state = randomString(), verifier = randomString();
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    sessionStorage.setItem(FLOW, JSON.stringify({ state, verifier }));
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({
      client_id: this.clientId, redirect_uri: redirectUri(), state, code_challenge: challenge, code_challenge_method: 'S256',
    });
    location.assign(url);
  }

  /** Kończy logowanie po powrocie z GitHuba (adres z ?code=…). */
  async handleRedirect() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code'), error = params.get('error');
    if (!code && !error) return;
    history.replaceState(null, '', redirectUri() + location.hash);
    let flow = null;
    try { flow = JSON.parse(sessionStorage.getItem(FLOW) || 'null'); sessionStorage.removeItem(FLOW); } catch {}
    if (error) throw new AuthError(error === 'access_denied' ? 'Logowanie zostało anulowane.' : params.get('error_description') || error);
    if (!flow || flow.state !== params.get('state')) throw new AuthError('Nieprawidłowa odpowiedź logowania — spróbuj ponownie.');
    write(fromResponse(await this.call('/token', { code, code_verifier: flow.verifier, redirect_uri: redirectUri() })));
  }

  async call(path, body) {
    let res;
    try {
      res = await fetch(this.proxy + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      throw Object.assign(new AuthError('Nie można połączyć się z serwerem logowania.'), { network: true });
    }
    const d = await res.json().catch(() => ({}));
    if (!res.ok || d.error || !d.access_token) throw new AuthError(d.error_description || d.error || `Błąd logowania (${res.status})`);
    return d;
  }

  /** Aktualny token (odświeżany, gdy wygasa) albo null, gdy trzeba się zalogować. */
  async token() {
    const a = read();
    if (!a) return null;
    if (!a.expires_at || a.expires_at - MARGIN > Date.now()) return a.access_token;
    return this.refresh();
  }

  /** Odświeża token (też po odpowiedzi 401). Zwraca nowy token albo null. */
  refresh() {
    this.refreshing ||= (async () => {
      const a = read();
      if (!a?.refresh_token || (a.refresh_expires_at && a.refresh_expires_at < Date.now())) { write(null); return null; }
      try {
        const next = fromResponse(await this.call('/refresh', { refresh_token: a.refresh_token }));
        write(next);
        return next.access_token;
      } catch (e) {
        if (e.network) throw e;
        // inna karta mogła już odświeżyć token (refresh token jest jednorazowy)
        const now = read();
        if (now && now.access_token !== a.access_token) return now.access_token;
        write(null);
        return null;
      }
    })().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  logout() { write(null); }
}
