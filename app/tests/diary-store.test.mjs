import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiaryStore, validateEntry, toRow, fromRow } from '../src/diary-store.js';

const entry = { d: '2026-10-08', op: '', ns: true, m: 3, gd: 'Хорошая тренировка', im: '', sh: 0, g: 0, sa: 0, ga: 0 };
function memory() {
  const map = new Map();
  return { getItem: k => map.get(k) ?? null, setItem: (k,v) => map.set(k,v) };
}
test('local diary survives reload and storage failure is visible', async () => {
  const storage = memory();
  const store = new DiaryStore(null, storage);
  await store.add(entry);
  const loaded = await new DiaryStore(null, storage).list();
  assert.equal(loaded.length, 1);
  assert.ok(loaded[0].id);
  storage.setItem = () => { throw new Error('quota'); };
  await assert.rejects(store.add(entry), /Не удалось сохранить/);
  assert.equal((await store.list()).length, 1);
});
test('invalid dates and inconsistent or fractional stats are rejected', () => {
  for (const change of [{ d: '2026-02-30' }, { sh: -1 }, { m: 6 }, { sh: 1.5 },
    { ns: false, sh: 10, g: 5, sa: 9, ga: 0 }]) {
    assert.throws(() => validateEntry({ ...entry, ...change }));
  }
  assert.equal(fromRow(toRow({ ...entry, id: 'id' }, 'user')).gd, entry.gd);
});
test('import keeps stable IDs, does not overwrite cloud records and retains local backup', async () => {
  const storage = memory(); storage.setItem('dg', JSON.stringify([entry]));
  const rows = new Map();
  const client = { from: () => ({ upsert: async (batch, options) => {
    assert.equal(options.ignoreDuplicates, true);
    for (const row of batch) if (!rows.has(row.id)) rows.set(row.id, row);
    return { error: null };
  } }) };
  const store = new DiaryStore(client, storage); store.setUser({ id: 'A' });
  await store.importLocal(); await store.importLocal();
  assert.equal(rows.size, 1);
  assert.equal(JSON.parse(storage.getItem('dg')).length, 1);
  store.setUser(null);
  assert.deepEqual(await store.list(), []);
  store.setUser({ id: 'B' });
  await assert.rejects(store.importLocal(), /другим аккаунтом/);
});
test('failed cloud save never falls back to guest storage', async () => {
  const storage = memory();
  const client = { from: () => ({ upsert: async () => ({ error: { message: 'offline' } }) }) };
  const store = new DiaryStore(client, storage); store.setUser({ id: 'A' });
  await assert.rejects(store.add(entry), /Не удалось сохранить в аккаунте/);
  assert.equal(storage.getItem('dg'), null);
});
test('a response from an old account is rejected after logout', async () => {
  let finish;
  const client = { from: () => ({ upsert: () => new Promise(resolve => { finish = resolve; }) }) };
  const store = new DiaryStore(client, memory()); store.setUser({ id: 'A' });
  const pending = store.add(entry);
  store.setUser(null); finish({ error: null });
  await assert.rejects(pending, /Аккаунт изменился/);
});
