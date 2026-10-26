import assert from 'node:assert/strict';
import test from 'node:test';
import { toMap, merge3, diff, serializePerson, commitMessage, repairIntegrity } from '../js/merge.js';

const P = (id, data = {}, rels = {}) => ({ id, data: { gender: 'M', ...data }, rels });
const base = toMap([
  P('a', { 'first name': 'Jan' }, { children: ['c'], spouses: ['b'] }),
  P('b', { 'first name': 'Anna', gender: 'F' }, { children: ['c'], spouses: ['a'] }),
  P('c', { 'first name': 'Piotr' }, { parents: ['a', 'b'] }),
]);
const clone = (m) => toMap([...m.values()].map((p) => structuredClone(p)));

test('rozłączne zmiany pól się sumują', () => {
  const mine = clone(base); mine.get('a').data.birthday = '1950';
  const theirs = clone(base); theirs.get('a').data['last name'] = 'Kowalski';
  const { result, conflicts } = merge3(base, mine, theirs);
  assert.equal(conflicts.length, 0);
  assert.equal(result.get('a').data.birthday, '1950');
  assert.equal(result.get('a').data['last name'], 'Kowalski');
});

test('konflikt tego samego pola: wygrywa lokalna zmiana i jest raportowany', () => {
  const mine = clone(base); mine.get('c').data['first name'] = 'Piotruś';
  const theirs = clone(base); theirs.get('c').data['first name'] = 'Pietro';
  const { result, conflicts } = merge3(base, mine, theirs);
  assert.equal(result.get('c').data['first name'], 'Piotruś');
  assert.equal(conflicts.length, 1);
});

test('dwie osoby dodają dzieci tym samym rodzicom', () => {
  const mine = clone(base);
  mine.set('d', toMap([P('d', {}, { parents: ['a', 'b'] })]).get('d'));
  mine.get('a').rels.children.push('d'); mine.get('b').rels.children.push('d');
  const theirs = clone(base);
  theirs.set('e', toMap([P('e', {}, { parents: ['a', 'b'] })]).get('e'));
  theirs.get('a').rels.children.push('e'); theirs.get('b').rels.children.push('e');
  const { result, conflicts } = merge3(base, mine, theirs);
  assert.equal(conflicts.length, 0);
  assert.deepEqual(result.get('a').rels.children, ['c', 'e', 'd']);
  assert.deepEqual(result.get('b').rels.children, ['c', 'e', 'd']);
});

test('usunięcie osoby czyści odwołania także w zmianach drugiej strony', () => {
  const mine = clone(base);
  mine.delete('c'); mine.get('a').rels.children = []; mine.get('b').rels.children = [];
  const theirs = clone(base); theirs.get('a').data.birthday = '1940';
  const { result, conflicts } = merge3(base, mine, theirs);
  assert.equal(conflicts.length, 0);
  assert.ok(!result.has('c'));
  assert.deepEqual(result.get('a').rels.children, []);
  assert.equal(result.get('a').data.birthday, '1940');
});

test('usunięcie lokalne vs edycja zdalna: osoba zostaje, konflikt', () => {
  const mine = clone(base);
  mine.delete('c'); mine.get('a').rels.children = []; mine.get('b').rels.children = [];
  const theirs = clone(base); theirs.get('c').data.birthday = '1980';
  const { result, conflicts } = merge3(base, mine, theirs);
  assert.ok(result.has('c'));
  assert.equal(conflicts[0].kind, 'deleted-locally-but-edited-remotely');
  // relacje odtworzone dwustronnie
  assert.ok(result.get('a').rels.children.includes('c'));
});

test('diff i opis commita', () => {
  const after = clone(base); after.get('a').data['first name'] = 'Janusz'; after.delete('c');
  const d = diff(base, after);
  assert.deepEqual(d.changed, ['a']);
  assert.deepEqual(d.removed, ['c']);
  assert.match(commitMessage(base, after), /zmieniono: Janusz.*usunięto: Piotr/i);
});

test('serializacja jest stabilna', () => {
  const s1 = serializePerson({ id: 'x', data: { b: 1, a: 2, gender: 'F' }, rels: {} });
  const s2 = serializePerson({ id: 'x', rels: { children: [] }, data: { gender: 'F', a: 2, b: 1 } });
  assert.equal(s1, s2);
});

test('powiązania: równoległe dodanie różnych chrzestnych łączy się bez konfliktu', () => {
  const mine = clone(base); mine.get('c').data['link:a'] = 'godparent';
  const theirs = clone(base); theirs.get('c').data['link:b'] = 'godparent';
  const { result, conflicts } = merge3(base, mine, theirs);
  assert.equal(conflicts.length, 0);
  assert.equal(result.get('c').data['link:a'], 'godparent');
  assert.equal(result.get('c').data['link:b'], 'godparent');
});

test('powiązania do usuniętej osoby i do siebie są usuwane', () => {
  const m = clone(base);
  m.get('c').data['link:zzz'] = 'godparent';
  m.get('c').data['link:c'] = 'friend';
  m.get('c').data['link:a'] = 'godparent';
  repairIntegrity(m);
  assert.deepEqual(Object.keys(m.get('c').data).filter((k) => k.startsWith('link:')), ['link:a']);
});
