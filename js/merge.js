// Czysta logika danych: normalizacja, serializacja, porównywanie i scalanie 3-stronne.
// Bez zależności od przeglądarki — testowalne w Node.

export const REL_KEYS = ['parents', 'spouses', 'children'];

const uniq = (arr) => [...new Set(arr)];

/** Sprowadza osobę do kanonicznej postaci (format family-chart). */
export function normalizePerson(p) {
  const out = { id: String(p.id), data: {}, rels: {} };
  const data = p.data || {};
  for (const k of Object.keys(data)) {
    const v = data[k];
    if (v === undefined || v === null || v === '') continue;
    out.data[k] = v;
  }
  if (!out.data.gender) out.data.gender = 'M';
  const rels = p.rels || {};
  // zgodność wstecz: father/mother -> parents
  const parents = [...(rels.parents || [])];
  if (rels.father) parents.push(rels.father);
  if (rels.mother) parents.push(rels.mother);
  out.rels.parents = uniq(parents.map(String));
  out.rels.spouses = uniq((rels.spouses || []).map(String));
  out.rels.children = uniq((rels.children || []).map(String));
  if (p.unknown) out.unknown = true;
  return out;
}

/** JSON z posortowanymi kluczami obiektów (tablice zachowują kolejność). */
export function stableStringify(v, indent = 0) {
  return JSON.stringify(sortKeys(v), null, indent || undefined);
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
    return o;
  }
  return v;
}

/** Treść pliku osoby w repo — stabilna, czytelna w diffach. */
export function serializePerson(p) {
  const n = normalizePerson(p);
  const ordered = { id: n.id };
  if (n.unknown) ordered.unknown = true;
  ordered.data = sortKeys(n.data);
  ordered.rels = { parents: n.rels.parents, spouses: n.rels.spouses, children: n.rels.children };
  return JSON.stringify(ordered, null, 2) + '\n';
}

export const samePerson = (a, b) => stableStringify(normalizePerson(a)) === stableStringify(normalizePerson(b));
const sameVal = (a, b) => stableStringify(a) === stableStringify(b);

export function toMap(list) {
  const m = new Map();
  for (const p of list) {
    const n = normalizePerson(p);
    m.set(n.id, n);
  }
  return m;
}
export const toList = (map) => [...map.values()].map((p) => structuredClone(p));

/** Różnice między dwoma stanami: co dodano, zmieniono, usunięto (listy id). */
export function diff(from, to) {
  const added = [], changed = [], removed = [];
  for (const [id, p] of to) {
    if (!from.has(id)) added.push(id);
    else if (!samePerson(from.get(id), p)) changed.push(id);
  }
  for (const id of from.keys()) if (!to.has(id)) removed.push(id);
  return { added, changed, removed, count: added.length + changed.length + removed.length };
}

/** Scalenie jednego pola: zwraca {value, conflict}. Przy konflikcie wygrywa "mine". */
function mergeValue(b, m, t) {
  if (sameVal(m, t)) return { value: m };
  if (sameVal(m, b)) return { value: t };
  if (sameVal(t, b)) return { value: m };
  return { value: m, conflict: true };
}

/** Scalenie listy relacji jak zbioru: zmiany z obu stron się sumują. */
function mergeSet(b = [], m = [], t = []) {
  const bS = new Set(b), mS = new Set(m);
  const removedByMe = new Set(b.filter((x) => !mS.has(x)));
  const result = t.filter((x) => !removedByMe.has(x));
  for (const x of m) if (!bS.has(x) && !result.includes(x)) result.push(x);
  return result;
}

function mergePerson(b, m, t, conflicts) {
  const out = { id: m.id, data: {}, rels: {} };
  const keys = new Set([...Object.keys(b.data), ...Object.keys(m.data), ...Object.keys(t.data)]);
  for (const k of keys) {
    const r = mergeValue(b.data[k], m.data[k], t.data[k]);
    if (r.conflict) conflicts.push({ id: m.id, field: k, kind: 'field', mine: m.data[k], theirs: t.data[k] });
    if (r.value !== undefined) out.data[k] = r.value;
  }
  for (const k of REL_KEYS) out.rels[k] = mergeSet(b.rels[k], m.rels[k], t.rels[k]);
  const unk = mergeValue(!!b.unknown, !!m.unknown, !!t.unknown).value;
  if (unk) out.unknown = true;
  return normalizePerson(out);
}

/**
 * Scalenie 3-stronne.
 * base   – stan, od którego zaczęła edycja lokalna
 * mine   – stan lokalny (po edycji)
 * theirs – aktualny stan w repozytorium
 * Zwraca { result: Map, conflicts: [] }.
 */
export function merge3(base, mine, theirs) {
  const result = new Map();
  const conflicts = [];
  const ids = new Set([...base.keys(), ...mine.keys(), ...theirs.keys()]);

  for (const id of ids) {
    const b = base.get(id), m = mine.get(id), t = theirs.get(id);
    if (!b) {
      if (m && t) result.set(id, mergePerson({ id, data: {}, rels: {} }, m, t, conflicts));
      else if (m) result.set(id, m);
      else if (t) result.set(id, t);
      continue;
    }
    if (m && t) {
      result.set(id, mergePerson(b, m, t, conflicts));
    } else if (!m && t) {
      // usunięte lokalnie
      if (!samePerson(b, t)) {
        conflicts.push({ id, kind: 'deleted-locally-but-edited-remotely' });
        result.set(id, t);
      }
    } else if (m && !t) {
      // usunięte zdalnie
      if (!samePerson(b, m)) {
        conflicts.push({ id, kind: 'edited-locally-but-deleted-remotely' });
        result.set(id, m);
      }
    }
  }
  repairIntegrity(result);
  return { result, conflicts };
}

/** Usuwa odwołania do nieistniejących osób i uzupełnia relacje dwustronne. */
/** Pole danych z powiązaniem poza drzewem: data[`link:<id X>`] = typ („X jest dla tej osoby: typ”). */
export const LINK_PREFIX = 'link:';

export function repairIntegrity(map) {
  for (const p of map.values())
    for (const k of Object.keys(p.data))
      if (k.startsWith(LINK_PREFIX) && (k === LINK_PREFIX + p.id || !map.has(k.slice(LINK_PREFIX.length)))) delete p.data[k];
  for (const p of map.values())
    for (const k of REL_KEYS) p.rels[k] = p.rels[k].filter((id) => map.has(id) && id !== p.id);
  const ensure = (id, key, val) => {
    const p = map.get(id);
    if (p && !p.rels[key].includes(val)) p.rels[key].push(val);
  };
  for (const p of map.values()) {
    for (const c of p.rels.children) ensure(c, 'parents', p.id);
    for (const par of p.rels.parents) ensure(par, 'children', p.id);
    for (const s of p.rels.spouses) ensure(s, 'spouses', p.id);
  }
  return map;
}

export function displayName(p) {
  if (!p) return '?';
  const d = p.data || {};
  const name = [d['first name'], d['last name']].filter(Boolean).join(' ');
  return name || (p.unknown ? 'nieznana osoba' : 'bez imienia');
}

/** Opis commita na podstawie różnic. */
export function commitMessage(before, after, note) {
  const { added, changed, removed } = diff(before, after);
  const names = (ids, map) => {
    const n = ids.map((id) => displayName(map.get(id)));
    return n.length > 4 ? `${n.slice(0, 4).join(', ')} i ${n.length - 4} innych` : n.join(', ');
  };
  const parts = [];
  if (added.length) parts.push(`dodano: ${names(added, after)}`);
  if (changed.length) parts.push(`zmieniono: ${names(changed, after)}`);
  if (removed.length) parts.push(`usunięto: ${names(removed, before)}`);
  const summary = parts.join('; ') || 'aktualizacja drzewa';
  const title = note && note.trim() ? note.trim() : summary.charAt(0).toUpperCase() + summary.slice(1);
  return note && note.trim() ? `${title}\n\n${summary}` : title;
}
