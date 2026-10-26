import { GitHubStore, ConflictError } from './github.js';
import { Auth } from './auth.js';
import { toMap, toList, merge3, diff, commitMessage, displayName, normalizePerson, repairIntegrity, LINK_PREFIX } from './merge.js';
import { translateTree } from './i18n.js';

const f3 = window.f3;
const CFG = window.FAMILY_TREE_CONFIG || {};
const LS = 'family-tree:';
const auth = new Auth(CFG);
const MAX_SAVE_ATTEMPTS = 5;

const FIELDS = [
  { type: 'text', label: 'Imię', id: 'first name' },
  { type: 'text', label: 'Nazwisko', id: 'last name' },
  { type: 'text', label: 'Nazwisko rodowe', id: 'birth name' },
  { type: 'text', label: 'Data urodzenia', id: 'birthday' },
  { type: 'text', label: 'Miejsce urodzenia', id: 'birthplace' },
  { type: 'text', label: 'Data śmierci', id: 'death' },
  { type: 'text', label: 'Zdjęcie (URL)', id: 'avatar' },
  { type: 'textarea', label: 'Notatki', id: 'notes' },
];

// Powiązania poza drzewem. label: kim jest druga osoba (wg jej płci); inverse: jak to wygląda z jej strony.
// Typy bez inverse są symetryczne. Identyfikatorów (id) nie zmieniaj — są zapisane w danych.
const LINK_TYPES = [
  { id: 'godparent', name: 'Chrzestny / chrzestna', label: { M: 'Chrzestny', F: 'Chrzestna' },
    inverseName: 'Chrześniak / chrześniaczka', inverse: { M: 'Chrześniak', F: 'Chrześniaczka' } },
  { id: 'guardian', name: 'Opiekun / opiekunka', label: { M: 'Opiekun', F: 'Opiekunka' },
    inverseName: 'Podopieczny / podopieczna', inverse: { M: 'Podopieczny', F: 'Podopieczna' } },
  { id: 'friend', name: 'Przyjaciel / przyjaciółka', label: { M: 'Przyjaciel', F: 'Przyjaciółka' } },
  { id: 'other', name: 'Inne powiązanie', label: { M: 'Powiązanie', F: 'Powiązanie' } },
];

// ---------- stan ----------
const state = {
  store: null,
  base: new Map(),   // ostatni znany stan repo (punkt wyjścia edycji)
  baseHead: null,    // commit, z którego pochodzi base
  local: new Map(),  // stan po edycjach lokalnych
  remoteHead: null,  // ostatnio zauważony commit w repo
  saving: false,
  pollTimer: null,
};
let chart, card, edit;

const $ = (id) => document.getElementById(id);
// rok z daty w dowolnym formacie („12.03.1920”, „1920-03-12”, „ok. 1920”); bez roku — cały tekst
const year = (date) => (date ? String(date).match(/\b\d{4}\b/)?.[0] || date : '');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const el = {
  status: $('status'), save: $('btn-save'), discard: $('btn-discard'), note: $('commit-note'),
  banner: $('banner'), bannerText: $('banner-text'), toast: $('toast'), avatar: $('avatar'),
  menu: $('menu'), repoLink: $('repo-link'), login: $('login'), loginForm: $('login-form'), loginError: $('login-error'),
};
const draftKey = () => `${LS}draft:${state.store.owner}/${state.store.repo}/${state.store.branch}/${state.store.dir}`;

// ---------- UI pomocnicze ----------
function setStatus(text, s = 'idle') { el.status.textContent = text; el.status.dataset.state = s; }

let toastTimer;
function toast(msg, ms = 4000) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), ms);
}

function banner(text, actions = []) {
  if (!text) { el.banner.hidden = true; return; }
  el.bannerText.textContent = text;
  const box = el.banner.querySelector('.banner-actions');
  box.replaceChildren(...actions.map(([label, fn]) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    return b;
  }));
  el.banner.hidden = false;
}

function describeConflicts(conflicts, map) {
  if (!conflicts.length) return '';
  const names = [...new Set(conflicts.map((c) => displayName(map.get(c.id))))];
  return `Te same dane zmieniła inna osoba: ${names.slice(0, 5).join(', ')}${names.length > 5 ? '…' : ''}. Zachowano Twoje wersje pól; usunięcia kolidujące z edycją zostały cofnięte.`;
}

// ---------- wykres ----------
function chartData(map) {
  const list = toList(map);
  if (!list.length) list.push(normalizePerson({ id: crypto.randomUUID(), data: { gender: 'M', 'first name': 'Pierwsza', 'last name': 'osoba' } }));
  return list;
}

function createChart(map) {
  const cont = document.querySelector('#FamilyChart');
  cont.replaceChildren();
  chart = f3.createChart('#FamilyChart', chartData(map))
    .setTransitionTime(700)
    .setCardXSpacing(260)
    .setCardYSpacing(160)
    .setSingleParentEmptyCard(true, { label: 'Nieznany' })
    .setShowSiblingsOfMain(true);
  chart.store.state.unknown_card_label = 'Nieznany'; // biblioteka nie ma do tego settera

  card = chart.setCardHtml()
    .setCardDisplay([
      // znacznik card-deceased przygasza kafelek (css/style.css)
      (p) => esc([p.data['first name'], p.data['last name']].filter(Boolean).join(' '))
        + (p.data.death ? '<span class="card-deceased" hidden></span>' : ''),
      (p) => esc([year(p.data.birthday), p.data.death && `† ${year(p.data.death)}`].filter(Boolean).join(' – ')),
    ])
    .setCardImageField('avatar')
    .setMiniTree(true)
    .setStyle('imageRect')
    .setOnHoverPathToMain();

  edit = chart.editTree()
    .fixed()
    .setFields(FIELDS)
    .setEditFirst(false)
    .setAddRelLabels({ father: 'Dodaj ojca', mother: 'Dodaj matkę', spouse: 'Dodaj małżonka', son: 'Dodaj syna', daughter: 'Dodaj córkę' })
    .setLinkExistingRelConfig({ title: 'Albo połącz z istniejącą osobą', select_placeholder: 'Wybierz osobę', linkRelLabel: (d) => displayName(d) })
    .setCardClickOpen(card)
    .setOnFormCreation((args) => { addLinksSection(args); addSiblingButtons(args); })
    .setOnSubmit((ev, datum, applyForm, done) => {
      ev.preventDefault();
      applyForm();
      applyLinkOps();
      done();
    })
    .setOnDelete((d, deletePerson, done) => {
      if (!confirm(`Czy na pewno chcesz usunąć osobę ${displayName(d)}?`)) return;
      deletePerson();
      done();
    })
    .setOnChange(onLocalChange);

  // Istniejące osoby otwierają się do odczytu (edycja ołówkiem), puste karty „Nieznany” — od razu do edycji.
  // Nowe osoby z kart „Dodaj …” biblioteka zawsze otwiera do edycji.
  const open = edit.open.bind(edit);
  edit.open = (d) => {
    const p = d.rels ? d : d.data;
    edit.setEditFirst(!!(p.unknown || p.to_add));
    open(d);
    edit.setEditFirst(false);
  };

  chart.setPersonDropdown((d) => displayName(d), { placeholder: 'Szukaj osoby' });

  const root = mainLineRootId();
  if (root) chart.updateMainId(root); // start od głównej linii
  chart.updateTree({ initial: true });
  updateLineageOptions();
  // jeśli repo puste, osoba startowa jest zmianą do zapisania
  onLocalChange();
}

// family-chart nie ma „dodaj brata/siostrę” — rodzeństwo to kolejne dziecko tych samych rodziców.
function addSiblingButtons({ cont, form_creator }) {
  const d = chart.store.getDatum(form_creator.datum_id);
  const submitRow = cont.querySelector('form button[type=submit]')?.parentElement;
  if (!d || !submitRow || d._new_rel_data || d.unknown || d.to_add) return;
  const box = document.createElement('div');
  box.className = 'f3-siblings';
  for (const [gender, label] of [['M', 'Dodaj brata'], ['F', 'Dodaj siostrę']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.onclick = () => addSibling(d.id, gender);
    box.append(b);
  }
  submitRow.before(box);
}

function addSibling(id, gender) {
  const data = chart.store.getData();
  const person = data.find((p) => p.id === id);
  person.rels.parents ||= [];
  if (!person.rels.parents.length) {
    // bez rodziców: wspólny rodzic „Nieznany”, którego można później uzupełnić
    const parent = { id: crypto.randomUUID(), data: { gender: 'M' }, rels: { parents: [], spouses: [], children: [id] }, unknown: true };
    person.rels.parents.push(parent.id);
    data.push(parent);
  }
  const sibling = {
    id: crypto.randomUUID(),
    data: { gender, ...(person.data['last name'] ? { 'last name': person.data['last name'] } : {}) },
    rels: { parents: [...person.rels.parents], spouses: [], children: [] },
  };
  for (const pid of sibling.rels.parents) {
    const parent = data.find((p) => p.id === pid);
    (parent.rels.children ||= []).push(sibling.id);
  }
  data.push(sibling);
  chart.updateTree({ tree_position: 'inherit' });
  edit.setEditFirst(true);
  edit.openFormWithId(sibling.id);
  edit.setEditFirst(false);
  onLocalChange();
}

// ---------- powiązania (chrzestni itp.) ----------
// Niezatwierdzone zmiany powiązań w otwartym formularzu: "osoba|pole" -> { personId, key, value }.
let linkEdit = { id: null, ops: new Map() };

const isPlaceholder = (p) => !p || p._new_rel_data || p.unknown || p.to_add;
const genderOf = (p) => (p?.data.gender === 'F' ? 'F' : 'M');

function linkValue(personId, key) {
  const op = linkEdit.ops.get(`${personId}|${key}`);
  return op ? op.value : chart.store.getDatum(personId)?.data[key] || null;
}

/**
 * Powiązania osoby id: zapisane u niej i u innych osób (wskazujące na nią), z uwzględnieniem niezatwierdzonych zmian.
 * To samo powiązanie zapisane z obu stron (np. „przyjaciel” dodany równolegle u obu osób) jest jedną pozycją
 * z kilkoma wpisami w slots — usunięcie usuwa wszystkie.
 */
function linksOf(id) {
  const slots = new Map();
  const add = (personId, key) => slots.set(`${personId}|${key}`, { personId, key });
  for (const k of Object.keys(chart.store.getDatum(id).data)) if (k.startsWith(LINK_PREFIX)) add(id, k);
  for (const p of chart.store.getData()) if (p.id !== id && p.data[LINK_PREFIX + id]) add(p.id, LINK_PREFIX + id);
  for (const op of linkEdit.ops.values()) if (op.personId === id || op.key === LINK_PREFIX + id) add(op.personId, op.key);
  const out = new Map();
  for (const { personId, key } of slots.values()) {
    const type = LINK_TYPES.find((t) => t.id === linkValue(personId, key));
    const otherId = personId === id ? key.slice(LINK_PREFIX.length) : personId;
    const other = chart.store.getDatum(otherId);
    if (!type || !other) continue;
    const g = genderOf(other);
    const label = personId !== id && type.inverse ? type.inverse[g] : type.label[g];
    const same = out.get(`${otherId}|${label}`);
    if (same) same.slots.push({ personId, key });
    else out.set(`${otherId}|${label}`, { slots: [{ personId, key }], otherId, other, label });
  }
  return [...out.values()].sort((a, b) => a.label.localeCompare(b.label, 'pl') || displayName(a.other).localeCompare(displayName(b.other), 'pl'));
}

function applyLinkOps() {
  for (const { personId, key, value } of linkEdit.ops.values()) {
    const p = chart.store.getDatum(personId);
    if (!p) continue;
    if (value) p.data[key] = value;
    else delete p.data[key];
  }
  linkEdit.ops.clear();
}

function addLinksSection({ cont, form_creator }) {
  const d = chart.store.getDatum(form_creator.datum_id);
  const submitRow = cont.querySelector('form button[type=submit]')?.parentElement;
  if (isPlaceholder(d) || !submitRow) return;
  if (linkEdit.id !== d.id || !form_creator.editable) linkEdit = { id: d.id, ops: new Map() };
  const box = document.createElement('div');
  box.className = 'f3-links';
  submitRow.before(box);
  renderLinks(box, d, form_creator.editable);
}

function renderLinks(box, d, editable) {
  const make = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const setOps = (slots, value) => {
    for (const { personId, key } of slots) linkEdit.ops.set(`${personId}|${key}`, { personId, key, value });
    renderLinks(box, d, editable);
  };
  const links = linksOf(d.id);
  box.replaceChildren();
  if (!links.length && !editable) return;
  box.append(make('div', { className: 'f3-links-title', textContent: 'Powiązania' }));

  for (const l of links) {
    const name = editable
      ? make('span', { textContent: displayName(l.other) })
      : make('button', { type: 'button', className: 'f3-link-name', textContent: displayName(l.other), title: 'Pokaż tę osobę', onclick: () => showPerson(l.otherId) });
    const row = make('div', { className: 'f3-link' }, make('span', { className: 'f3-link-label', textContent: `${l.label}:` }), name);
    if (editable) row.append(make('button', { type: 'button', className: 'f3-link-remove', textContent: '×', title: 'Usuń powiązanie', onclick: () => setOps(l.slots, null) }));
    box.append(row);
  }

  if (!editable) return;
  const typeSel = make('select', {}, make('option', { value: '', textContent: 'Rodzaj…' }));
  for (const t of LINK_TYPES) {
    typeSel.append(make('option', { value: t.id, textContent: t.name }));
    if (t.inverse) typeSel.append(make('option', { value: '~' + t.id, textContent: t.inverseName }));
  }
  const personSel = make('select', {}, make('option', { value: '', textContent: 'Osoba…' }));
  const candidates = chart.store.getData().filter((p) => p.id !== d.id && !isPlaceholder(p))
    .map((p) => ({ id: p.id, text: displayName(p) + (p.data.birthday ? ` (ur. ${p.data.birthday})` : '') }))
    .sort((a, b) => a.text.localeCompare(b.text, 'pl'));
  for (const c of candidates) personSel.append(make('option', { value: c.id, textContent: c.text }));
  const addBtn = make('button', { type: 'button', textContent: 'Dodaj', onclick: () => {
    const type = typeSel.value, other = personSel.value;
    if (!type || !other) return toast('Wybierz rodzaj powiązania i osobę');
    // jedna para osób = jedno powiązanie (w danych to jedno pole), niezależnie od strony, po której je zapisano
    const existing = links.find((l) => l.otherId === other);
    if (existing) return toast(`${displayName(d)} i ${displayName(existing.other)} są już powiązani (${existing.label.toLowerCase()}). Aby to zmienić, usuń najpierw obecne powiązanie.`, 6000);
    // „~typ” = druga osoba jest np. chrześniakiem tej osoby, więc wpis trafia do jej danych
    if (type.startsWith('~')) setOps([{ personId: other, key: LINK_PREFIX + d.id }], type.slice(1));
    else setOps([{ personId: d.id, key: LINK_PREFIX + other }], type);
  } });
  box.append(make('div', { className: 'f3-link-add' }, typeSel, personSel, addBtn));
}

function showPerson(id) {
  chart.updateMainId(id);
  chart.updateTree({});
  edit.open(chart.store.getDatum(id));
}

// ---------- główna linia i rody ----------
// family-chart rysuje przodków i potomków osoby głównej, więc widok „od przodka” pokazuje jego linię:
// potomków razem z ich małżonkami.

const realPeople = () => chart.store.getData().filter((p) => !p._new_rel_data && !p.to_add);

/** Nazwisko rodu: rodowe, jeśli wpisane (żona z nazwiskiem męża), w formie męskiej (Kowalska -> Kowalski). */
function familyName(p) {
  const n = (p.data['birth name'] || p.data['last name'] || '').trim();
  return n.replace(/(sk|ck|dzk)a$/i, '$1i');
}
const sameName = (a, b) => a.localeCompare(b, 'pl', { sensitivity: 'base' }) === 0;

/** Spośród kandydatów wybiera przodka z najdłuższą linią; przy remisie mężczyznę, potem starszego. */
function bestAncestor(candidates, byId) {
  const lineSize = (rootId) => {
    const seen = new Set();
    const visit = (id) => {
      const p = byId.get(id);
      if (!p || seen.has(id)) return;
      seen.add(id);
      for (const s of p.rels.spouses || []) if (byId.has(s)) seen.add(s);
      for (const c of p.rels.children || []) visit(c);
    };
    visit(rootId);
    return seen.size;
  };
  const born = (p) => Number(year(p.data.birthday)) || Infinity;
  return candidates
    .map((p) => ({ p, size: lineSize(p.id) }))
    .sort((a, b) => b.size - a.size || (a.p.data.gender === 'M' ? -1 : 0) - (b.p.data.gender === 'M' ? -1 : 0) || born(a.p) - born(b.p))[0]?.p.id;
}

/** Główna linia: przodek (osoba bez rodziców) z największą liczbą potomków. */
function mainLineRootId() {
  const data = realPeople();
  return bestAncestor(data.filter((p) => !(p.rels.parents || []).length), new Map(data.map((p) => [p.id, p])));
}

/** Pierwszy przodek rodu: osoba o tym nazwisku, której żaden z rodziców go nie nosi. */
function lineageRootId(name) {
  const data = realPeople();
  const byId = new Map(data.map((p) => [p.id, p]));
  const heads = data.filter((p) => sameName(familyName(p), name)
    && !(p.rels.parents || []).some((id) => byId.has(id) && sameName(familyName(byId.get(id)), name)));
  return bestAncestor(heads, byId);
}

function showFrom(root) {
  if (!root) return;
  edit.closeForm();
  chart.updateMainId(root);
  chart.updateTree({ tree_position: 'fit' });
}

/** Lista rodów w górnym pasku, z liczbą osób. */
function updateLineageOptions() {
  const counts = new Map();
  for (const p of realPeople()) {
    const n = familyName(p);
    if (!n) continue;
    const key = [...counts.keys()].find((k) => sameName(k, n)) || n;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const sel = $('lineage');
  const opt = (value, text) => Object.assign(document.createElement('option'), { value, textContent: text });
  sel.replaceChildren(
    opt('', 'Pokaż ród…'),
    ...[...counts].sort((a, b) => a[0].localeCompare(b[0], 'pl')).map(([n, c]) => opt(n, `${n} (${c})`)),
  );
}

function refreshChart(map) {
  if (!chart) return createChart(map);
  if (edit) edit.closeForm();
  const mainId = chart.store.getMainId();
  const data = chartData(map);
  chart.updateData(data);
  if (!data.find((d) => d.id === mainId)) chart.updateMainId(data[0].id);
  chart.updateTree({ tree_position: 'inherit' });
  updateLineageOptions();
  if (map.size === 0) onLocalChange();
}

function readChart() {
  const exported = edit.exportData();
  return repairIntegrity(toMap(exported));
}

// ---------- zmiany lokalne ----------
function onLocalChange() {
  state.local = readChart();
  updateLineageOptions();
  updateDirtyUi();
  saveDraft();
}

function dirtyCount() { return diff(state.base, state.local).count; }

function updateDirtyUi() {
  const n = dirtyCount();
  el.save.disabled = state.saving || n === 0;
  el.discard.hidden = n === 0 || state.saving;
  el.note.hidden = n === 0;
  if (state.saving) return;
  if (n === 0) setStatus('Zsynchronizowano', 'ok');
  else setStatus(n === 1 ? '1 niezapisana zmiana' : `${n} niezapisanych zmian`, 'dirty');
}

function saveDraft() {
  try {
    if (dirtyCount() === 0) return localStorage.removeItem(draftKey());
    localStorage.setItem(draftKey(), JSON.stringify({
      savedAt: new Date().toISOString(), baseHead: state.baseHead, base: toList(state.base), local: toList(state.local),
    }));
  } catch {}
}
function clearDraft() { try { localStorage.removeItem(draftKey()); } catch {} }

function restoreDraftIfAny() {
  let draft;
  try { draft = JSON.parse(localStorage.getItem(draftKey()) || 'null'); } catch {}
  if (!draft) return;
  const dBase = toMap(draft.base), dLocal = toMap(draft.local);
  if (diff(dBase, dLocal).count === 0) return clearDraft();
  const when = new Date(draft.savedAt).toLocaleString('pl-PL');
  banner(`Masz niezapisane zmiany z ${when}.`, [
    ['Przywróć', () => {
      const { result, conflicts } = merge3(dBase, dLocal, state.base);
      state.local = result;
      refreshChart(result);
      updateDirtyUi();
      saveDraft();
      banner(describeConflicts(conflicts, result) || null, conflicts.length ? [['OK', () => banner(null)]] : []);
    }],
    ['Odrzuć', () => { clearDraft(); banner(null); }],
  ]);
}

// ---------- wczytywanie i synchronizacja ----------
async function loadRemote() {
  const { head, people } = await state.store.load();
  state.remoteHead = head;
  return { head, map: toMap(people) };
}

async function fullReload() {
  setStatus('Wczytywanie…', 'busy');
  const { head, map } = await loadRemote();
  state.base = map;
  state.baseHead = head;
  state.local = structuredClone(map);
  refreshChart(map);
  banner(null);
  updateDirtyUi();
}

/** Wciąga nowe zmiany z repo do widoku, zachowując lokalne edycje. */
async function pullAndMerge() {
  const { head, map: theirs } = await loadRemote();
  const { result, conflicts } = merge3(state.base, state.local, theirs);
  state.base = theirs;
  state.baseHead = head;
  state.local = result;
  refreshChart(result);
  updateDirtyUi();
  saveDraft();
  return conflicts;
}

async function save() {
  if (state.saving || dirtyCount() === 0) return;
  state.saving = true;
  updateDirtyUi();
  setStatus('Zapisywanie…', 'busy');
  const note = el.note.value;
  try {
    let theirs = state.base, parent = state.baseHead, conflicts = [];
    for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt++) {
      const merged = merge3(state.base, state.local, theirs);
      conflicts = merged.conflicts;
      const result = merged.result;
      const d = diff(theirs, result);
      if (d.count === 0) {
        finishSave(parent, theirs, conflicts);
        return;
      }
      try {
        const newHead = await state.store.commit({
          parent,
          writes: [...d.added, ...d.changed].map((id) => result.get(id)),
          deletes: d.removed,
          message: commitMessage(theirs, result, note),
        });
        finishSave(newHead, result, conflicts);
        return;
      } catch (e) {
        if (!(e instanceof ConflictError) || attempt === MAX_SAVE_ATTEMPTS) throw e;
        setStatus('Ktoś zapisał w tym samym czasie — scalanie…', 'busy');
        const remote = await loadRemote();
        theirs = remote.map;
        parent = remote.head;
      }
    }
  } catch (e) {
    console.error(e);
    state.saving = false;
    updateDirtyUi();
    if (e.status === 401) return sessionExpired();
    const msg = e.status === 403 || e.status === 404
      ? `Brak uprawnień do zapisu — Twoje konto potrzebuje dostępu do zapisu w repozytorium ${CFG.owner}/${CFG.repo}.`
      : `Nie udało się zapisać: ${e.message}`;
    banner(msg, [['Spróbuj ponownie', () => { banner(null); save(); }]]);
    setStatus('Błąd zapisu', 'error');
  }
}

function finishSave(head, result, conflicts) {
  const changedByMerge = diff(state.local, result).count > 0;
  state.base = result;
  state.baseHead = head;
  state.remoteHead = head;
  state.local = structuredClone(result);
  state.saving = false;
  el.note.value = '';
  clearDraft();
  if (changedByMerge) refreshChart(result);
  updateDirtyUi();
  if (conflicts.length) banner(describeConflicts(conflicts, result), [['OK', () => banner(null)]]);
  else { banner(null); toast(changedByMerge ? 'Zapisano (scalono ze zmianami innych osób)' : 'Zapisano'); }
}

async function poll() {
  if (document.hidden || state.saving || !state.store) return;
  try {
    const head = await state.store.getHead();
    if (!head || head === state.baseHead) return;
    if (dirtyCount() === 0) {
      await pullAndMerge();
      toast('Wczytano nowe zmiany innych osób');
    } else if (head !== state.remoteHead || el.banner.hidden) {
      state.remoteHead = head;
      banner('Ktoś inny zapisał zmiany. Zostaną scalone przy Twoim zapisie.', [
        ['Scal teraz', async () => {
          banner(null);
          const conflicts = await pullAndMerge();
          if (conflicts.length) banner(describeConflicts(conflicts, state.local), [['OK', () => banner(null)]]);
          else toast('Scalono zmiany innych osób');
        }],
      ]);
    }
  } catch (e) {
    if (e.status === 401) return sessionExpired();
    console.warn('Sprawdzanie zmian nie powiodło się', e);
  }
}

// ---------- logowanie ----------
function openLogin(error) {
  el.loginError.hidden = !error;
  el.loginError.textContent = error || '';
  if (!el.login.open) el.login.showModal();
}

function sessionExpired() {
  clearInterval(state.pollTimer);
  auth.logout();
  setStatus('Wylogowano', 'error');
  openLogin('Sesja wygasła — zaloguj się ponownie. Niezapisane zmiany są zachowane w tej przeglądarce.');
}

el.loginForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  auth.logout();
  try { await auth.login(); } catch (e) { openLogin(e.message); }
});
el.login.addEventListener('cancel', (e) => e.preventDefault());

// ---------- start ----------
async function start() {
  try { localStorage.removeItem(LS + 'settings'); localStorage.removeItem(LS + 'token'); } catch {} // z wersji z tokenem
  document.title = CFG.title || document.title;
  $('title').textContent = CFG.title || 'Drzewo genealogiczne';
  el.repoLink.textContent = `${CFG.owner}/${CFG.repo}`;
  el.repoLink.href = `https://github.com/${CFG.owner}/${CFG.repo}`;
  let token;
  try {
    await auth.handleRedirect();
    token = await auth.token();
  } catch (e) {
    setStatus('Niezalogowano', 'error');
    return openLogin(e.message);
  }
  if (!token) { setStatus('Niezalogowano', 'idle'); return openLogin(); }

  state.store = new GitHubStore({ ...CFG, token: () => auth.token(), onUnauthorized: () => auth.refresh() });
  $('menu-history').href = state.store.historyUrl();
  setStatus('Łączenie…', 'busy');
  let user;
  try {
    user = await state.store.getUser();
    el.avatar.src = user.avatar_url;
    el.avatar.title = `Zalogowano jako ${user.login}`;
    el.avatar.hidden = false;
    await fullReload();
    restoreDraftIfAny();
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(poll, Math.max(10, CFG.pollSeconds || 30) * 1000);
  } catch (e) {
    console.error(e);
    state.store = null;
    setStatus('Błąd', 'error');
    if (e.status === 401) { auth.logout(); return openLogin('Sesja wygasła — zaloguj się ponownie.'); }
    if (e.status === 404 || e.status === 403) {
      return openLogin(`Konto ${user ? user.login : ''} nie ma dostępu do repozytorium ${CFG.owner}/${CFG.repo}. `
        + 'Poproś właściciela o zaproszenie albo zaloguj się na inne konto (najpierw wyloguj się z github.com).');
    }
    openLogin(e.message);
  }
}

// ---------- przyciski ----------
el.save.onclick = save;
$('lineage').onchange = (e) => {
  const v = e.target.value;
  e.target.value = ''; // ten sam ród można wybrać ponownie
  if (chart && v) showFrom(lineageRootId(v));
};
el.note.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
el.discard.onclick = () => {
  if (!confirm('Odrzucić wszystkie niezapisane zmiany?')) return;
  state.local = structuredClone(state.base);
  clearDraft();
  refreshChart(state.base);
  updateDirtyUi();
};
$('btn-menu').onclick = (e) => { e.stopPropagation(); el.menu.hidden = !el.menu.hidden; };
document.addEventListener('click', () => (el.menu.hidden = true));
$('menu-reload').onclick = async () => {
  if (dirtyCount() > 0) { await pullAndMerge(); toast('Scalono z aktualnym stanem repozytorium'); }
  else await fullReload();
};
$('menu-history').onclick = (e) => {
  if (!confirm('Otworzyć historię zmian na GitHubie?')) e.preventDefault();
};
$('menu-export').onclick = () => {
  if (!confirm('Pobrać wszystkie dane drzewa do pliku drzewo.json?')) return;
  const blob = new Blob([JSON.stringify(toList(state.local), null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'drzewo.json' });
  a.click();
  URL.revokeObjectURL(a.href);
};
// Wylogowuje z aplikacji i z GitHuba, inaczej kolejne „Zaloguj” wpuściłoby od razu to samo konto.
// GitHub nie pozwala wylogować z zewnątrz — jego strona wylogowania wymaga kliknięcia „Sign out”.
function logout() {
  if (dirtyCount() > 0 && !confirm('Masz niezapisane zmiany (zostaną zachowane jako szkic w tej przeglądarce). Wylogować?')) return;
  auth.logout();
  clearInterval(state.pollTimer);
  state.store = null; // szkic jest już zapisany, bez pytania „opuścić stronę?”
  location.assign('https://github.com/logout');
}
$('menu-logout').onclick = logout;
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
});
window.addEventListener('beforeunload', (e) => {
  if (state.store && dirtyCount() > 0) { e.preventDefault(); e.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

translateTree(document.querySelector('#FamilyChart'));
start();
