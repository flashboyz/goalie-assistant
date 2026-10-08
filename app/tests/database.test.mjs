import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('Postgres migration: owner isolation, constraints and account deletion', async () => {
  const db = new PGlite();
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  const entry = '33333333-3333-4333-8333-333333333333';
  try {
    await db.exec(`create role anon; create role authenticated;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
      grant usage on schema public, auth to authenticated, anon;
      insert into auth.users values ('${a}'), ('${b}');`);
    await db.exec(await readFile(new URL('../supabase/migrations/001_diary.sql', import.meta.url), 'utf8'));
    await db.exec('set role anon');
    await assert.rejects(db.query('select * from public.diary_entries'), /permission denied/);
    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [a]);
    await db.query('insert into public.profiles(id) values ($1)', [a]);
    await db.query(`insert into public.diary_entries(id,user_id,entry_date,good)
      values ($1,$2,'2026-10-08','Focus')`, [entry, a]);
    assert.equal((await db.query('select * from public.diary_entries')).rows.length, 1);
    await assert.rejects(db.query('update public.diary_entries set shots = -1'), /check constraint/);
    await assert.rejects(db.query('update public.diary_entries set user_id = $1', [b]), /row-level security/);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [b]);
    assert.equal((await db.query('select * from public.diary_entries')).rows.length, 0);
    assert.equal((await db.query('select * from public.profiles')).rows.length, 0);
    assert.equal((await db.query('delete from public.diary_entries returning id')).rows.length, 0);
    assert.equal((await db.query("update public.diary_entries set good='stolen' returning id")).rows.length, 0);
    await assert.rejects(db.query(`insert into public.diary_entries(id,user_id,entry_date,good)
      values (gen_random_uuid(),$1,'2026-10-08','Foreign')`, [a]), /row-level security/);
    await assert.rejects(db.query(`insert into public.diary_entries(id,user_id,entry_date,good)
      values ($1,$2,'2026-10-08','Foreign') on conflict(id) do update set good=excluded.good`, [entry,b]), /row-level security/);
    await db.exec('reset role');
    await db.query('delete from auth.users where id = $1', [a]);
    assert.equal((await db.query('select * from public.diary_entries')).rows.length, 0);
    assert.equal((await db.query('select * from public.profiles')).rows.length, 0);
  } finally { await db.close(); }
});
