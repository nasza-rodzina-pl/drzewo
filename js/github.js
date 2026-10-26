// Dostęp do repozytorium przez GitHub REST API (Git Data API).
// Każdy zapis to jeden atomowy commit; aktualizacja gałęzi bez "force",
// więc równoległy zapis innej osoby kończy się ConflictError zamiast nadpisania.

import { normalizePerson, serializePerson } from './merge.js';

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}
export class ConflictError extends GitHubError {}

function decodeBase64Utf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

export class GitHubStore {
  /** token: tekst albo funkcja (async) zwracająca aktualny token; onUnauthorized: odświeża token po 401. */
  constructor({ owner, repo, branch = 'main', dir = 'people', token, onUnauthorized }) {
    Object.assign(this, { owner, repo, branch, dir: dir.replace(/^\/+|\/+$/g, ''), token, onUnauthorized });
    this.blobCache = new Map(); // sha bloba -> osoba
    this.pathById = new Map(); // id osoby -> ścieżka pliku
    this.refEtag = null;
    this.lastHead = null;
  }

  get repoPath() {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  async request(path, opts = {}, retry = true) {
    const { method = 'GET', body, headers = {} } = opts;
    const token = typeof this.token === 'function' ? await this.token() : this.token;
    const res = await fetch(API + path, {
      method,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && retry && this.onUnauthorized && (await this.onUnauthorized())) return this.request(path, opts, false);
    if (res.status === 304) return { notModified: true, res };
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = (data && data.message) || res.statusText;
      throw new GitHubError(`${method} ${path}: ${res.status} ${msg}`, res.status, data);
    }
    return { data, res };
  }

  async getUser() {
    return (await this.request('/user')).data;
  }

  async getRepoInfo() {
    return (await this.request(this.repoPath)).data;
  }

  /** Aktualny commit gałęzi. Z ETag — zapytanie 304 nie zużywa limitu API. */
  async getHead() {
    const r = await this.request(`${this.repoPath}/git/ref/heads/${this.branch}`, {
      headers: this.refEtag ? { 'If-None-Match': this.refEtag } : {},
    });
    if (r.notModified) return this.lastHead;
    this.refEtag = r.res.headers.get('ETag');
    this.lastHead = r.data.object.sha;
    return this.lastHead;
  }

  /** Wczytuje wszystkie osoby z katalogu danych. Zwraca { head, treeSha, people: Person[] }. */
  async load() {
    let head;
    try {
      head = await this.getHead();
    } catch (e) {
      if (e.status === 409) throw new GitHubError('Repozytorium jest puste — utwórz w nim pierwszy commit (np. README).', 409);
      if (e.status === 404) throw new GitHubError(`Nie znaleziono repozytorium lub gałęzi "${this.branch}" (albo Twoje konto nie ma do nich dostępu).`, 404);
      throw e;
    }
    const commit = (await this.request(`${this.repoPath}/git/commits/${head}`)).data;
    const treeSha = commit.tree.sha;
    const tree = (await this.request(`${this.repoPath}/git/trees/${treeSha}?recursive=1`)).data;
    if (tree.truncated) console.warn('Drzewo repozytorium zostało obcięte przez API — część plików może być pominięta.');

    const prefix = this.dir ? this.dir + '/' : '';
    const entries = tree.tree.filter(
      (e) => e.type === 'blob' && e.path.startsWith(prefix) && e.path.endsWith('.json') && !e.path.slice(prefix.length).includes('/')
    );

    const pathById = new Map();
    const people = await pool(entries, 8, async (e) => {
      let person = this.blobCache.get(e.sha);
      if (!person) {
        const blob = (await this.request(`${this.repoPath}/git/blobs/${e.sha}`)).data;
        try {
          person = normalizePerson(JSON.parse(decodeBase64Utf8(blob.content)));
        } catch (err) {
          console.error(`Nie udało się odczytać ${e.path}`, err);
          return null;
        }
        this.blobCache.set(e.sha, person);
      }
      pathById.set(person.id, e.path);
      return structuredClone(person);
    });
    this.pathById = pathById;
    return { head, treeSha, people: people.filter(Boolean) };
  }

  pathFor(id) {
    if (this.pathById.has(id)) return this.pathById.get(id);
    const safe = String(id).replace(/[^A-Za-z0-9_-]/g, '_');
    return (this.dir ? this.dir + '/' : '') + safe + '.json';
  }

  /**
   * Tworzy commit na gałęzi.
   * writes: Person[] do zapisania, deletes: id[] do usunięcia.
   * Rzuca ConflictError, gdy gałąź w międzyczasie się przesunęła.
   */
  async commit({ parent, writes, deletes, message }) {
    const parentCommit = (await this.request(`${this.repoPath}/git/commits/${parent}`)).data;
    const tree = [
      ...writes.map((p) => ({ path: this.pathFor(p.id), mode: '100644', type: 'blob', content: serializePerson(p) })),
      ...deletes.map((id) => ({ path: this.pathFor(id), mode: '100644', type: 'blob', sha: null })),
    ];
    const newTree = (await this.request(`${this.repoPath}/git/trees`, {
      method: 'POST',
      body: { base_tree: parentCommit.tree.sha, tree },
    })).data;
    const newCommit = (await this.request(`${this.repoPath}/git/commits`, {
      method: 'POST',
      body: { message, tree: newTree.sha, parents: [parent] },
    })).data;
    try {
      await this.request(`${this.repoPath}/git/refs/heads/${this.branch}`, {
        method: 'PATCH',
        body: { sha: newCommit.sha, force: false },
      });
    } catch (e) {
      if (e.status === 422 || e.status === 409) throw new ConflictError('Gałąź zmieniła się w trakcie zapisu', e.status);
      throw e;
    }
    for (const p of writes) this.pathById.set(p.id, this.pathFor(p.id));
    for (const id of deletes) this.pathById.delete(id);
    this.lastHead = newCommit.sha;
    this.refEtag = null;
    return newCommit.sha;
  }

  historyUrl() {
    return `https://github.com/${this.owner}/${this.repo}/commits/${this.branch}/${this.dir}`;
  }
}
