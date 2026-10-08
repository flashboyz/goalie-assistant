export function validateEntry(entry) {
  const e = { ...entry };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.d || '') ||
      !Number.isFinite(Date.parse(e.d)) || new Date(e.d).toISOString().slice(0, 10) !== e.d) {
    throw new Error('Укажи правильную дату.');
  }
  for (const key of ['sh', 'g', 'sa', 'ga', 'm']) {
    if (!Number.isSafeInteger(e[key]) || e[key] < 0 || e[key] > 2147483647) throw new Error('Введи целые неотрицательные числа.');
  }
  if (e.m > 5 || e.g > e.sh || e.ga > e.g || e.sa > e.sh || e.ga > e.sa || e.g - e.ga > e.sh - e.sa) {
    throw new Error('Проверь число бросков и голов: общую статистику и каждый отрезок игры.');
  }
  if (e.ns && (e.sh || e.g || e.sa || e.ga)) throw new Error('У записи без статистики не должно быть бросков и голов.');
  for (const [key, max] of [['op', 200], ['gd', 10000], ['im', 10000], ['n', 10000]]) {
    e[key] = String(e[key] ?? '').trim();
    if (e[key].length > max) throw new Error('Запись слишком длинная. Сократи текст.');
  }
  if (e.ns && !e.m && !e.gd && !e.im && !e.n) throw new Error('Выбери настроение или напиши заметку.');
  return e;
}

export function toRow(e, userId) {
  e = validateEntry(e);
  return { id: e.id, user_id: userId, entry_date: e.d, opponent: e.op,
    no_stats: !!e.ns, mood: e.m, good: e.gd, improve: e.im, legacy_note: e.n,
    shots: e.sh, goals: e.g, shots_after: e.sa, goals_after: e.ga };
}

export function fromRow(r) {
  return { id: r.id, d: r.entry_date, op: r.opponent, ns: r.no_stats, m: r.mood,
    gd: r.good, im: r.improve, n: r.legacy_note,
    sh: r.shots, g: r.goals, sa: r.shots_after, ga: r.goals_after };
}

export class DiaryStore {
  constructor(client, storage) {
    this.client = client;
    this.storage = storage;
    this.user = null;
    this.ready = !client;
    this.revision = 0;
  }

  setUser(user) {
    if (this.user?.id !== user?.id || !this.ready) this.revision++;
    this.user = user;
    this.ready = true;
  }

  snapshot() {
    if (!this.ready) throw new Error('Подождите, проверяем вход.');
    return { user: this.user, revision: this.revision };
  }

  check(s) {
    if (s.revision !== this.revision) throw new Error('Аккаунт изменился. Открой дневник заново.');
  }

  readLocal() {
    let entries;
    try { entries = JSON.parse(this.storage.getItem('dg') || '[]'); }
    catch { throw new Error('Не удалось прочитать местный дневник. Данные не изменены.'); }
    if (!Array.isArray(entries)) throw new Error('Неверный формат местного дневника.');
    return entries;
  }

  writeLocal(entries) {
    try { this.storage.setItem('dg', JSON.stringify(entries)); }
    catch { throw new Error('Не удалось сохранить на устройстве. Освободи место и повтори.'); }
  }

  localWithIds() {
    const entries = this.readLocal();
    if (entries.some(e => !e.id)) {
      entries.forEach(e => { e.id ||= crypto.randomUUID(); });
      // Persist IDs before upload so a retry cannot create duplicates.
      this.writeLocal(entries);
    }
    return entries;
  }

  async list() {
    const s = this.snapshot();
    if (!s.user) return this.storage.getItem('gm-import-owner') ? [] : this.localWithIds();
    let entries = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await this.client.from('diary_entries').select('*')
        .eq('user_id', s.user.id).order('entry_date').order('id').range(offset, offset + 499);
      this.check(s);
      if (error) throw new Error('Не удалось загрузить дневник. Проверь соединение и повтори.');
      entries.push(...data.map(fromRow));
      if (data.length < 500) return entries;
    }
  }

  async add(entry) {
    const s = this.snapshot();
    entry = validateEntry({ ...entry, id: entry.id || crypto.randomUUID() });
    if (!s.user) {
      if (this.storage.getItem('gm-import-owner')) throw new Error('Войди в аккаунт, чтобы продолжить дневник.');
      const entries = this.localWithIds(); entries.push(entry); this.writeLocal(entries);
    }
    else {
      const { error } = await this.client.from('diary_entries')
        .upsert(toRow(entry, s.user.id), { onConflict: 'id' });
      this.check(s);
      if (error) throw new Error('Не удалось сохранить в аккаунте. Текст оставлен в форме, повтори попытку.');
    }
    return entry;
  }

  async remove(id) {
    const s = this.snapshot();
    if (!s.user) this.writeLocal(this.localWithIds().filter(e => e.id !== id));
    else {
      const { error } = await this.client.from('diary_entries').delete().eq('id', id).eq('user_id', s.user.id);
      this.check(s);
      if (error) throw new Error('Не удалось удалить запись. Повтори попытку.');
    }
  }

  async importLocal() {
    const s = this.snapshot();
    if (!s.user) throw new Error('Сначала войди в аккаунт.');
    const entries = this.localWithIds();
    // A local diary can be claimed by one account; keep the original as a backup.
    const owner = this.storage.getItem('gm-import-owner');
    if (owner && owner !== s.user.id) throw new Error('Этот дневник уже связан с другим аккаунтом.');
    const rows = entries.map(e => toRow(e, s.user.id));
    this.storage.setItem('gm-import-owner', s.user.id);
    for (let offset = 0; offset < rows.length; offset += 100) {
      this.check(s);
      const { error } = await this.client.from('diary_entries').upsert(rows.slice(offset, offset + 100),
        { onConflict: 'id', ignoreDuplicates: true });
      this.check(s);
      if (error) throw new Error('Импорт не завершён. Местные записи сохранены, можно повторить.');
    }
    return rows.length;
  }
}
