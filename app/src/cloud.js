import { createClient } from '@supabase/supabase-js';
import { DiaryStore } from './diary-store.js';

const el = id => document.getElementById(id);
const url = import.meta.env.VITE_SUPABASE_URL || '';
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) && key.startsWith('sb_publishable_');
const client = configured ? createClient(url, key) : null;
const store = new DiaryStore(client, localStorage);
window.GoalieStore = store;
let actionBusy = false;
let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === 'signup';
  el('auth-confirm-wrap').hidden = !signup;
  el('auth-password-confirm').disabled = !signup;
  el('auth-password-confirm').required = signup;
  el('auth-password-confirm').value = '';
  el('auth-password').value = '';
  el('auth-password').minLength = signup ? 8 : 1;
  el('auth-password').autocomplete = signup ? 'new-password' : 'current-password';
  el('auth-submit').textContent = signup ? 'Создать аккаунт' : 'Войти';
  for (const name of ['login', 'signup']) {
    el('auth-' + name + '-mode').classList.toggle('on', mode === name);
    el('auth-' + name + '-mode').setAttribute('aria-pressed', String(mode === name));
  }
  message(signup ? 'Придумай пароль длиной не менее 8 символов.' : '');
}
el('auth-login-mode').onclick = () => setAuthMode('login');
el('auth-signup-mode').onclick = () => setAuthMode('signup');

function message(text) { el('account-message').textContent = text; }
function renderAccount() {
  const user = store.user;
  el('account-name').textContent = user?.email || 'Личный аккаунт';
  el('auth-form').hidden = !client || !!user;
  el('signout').hidden = !user;
  el('import-local').hidden = !user;
  el('account-status').textContent = !client ? 'Облачное подключение ещё не настроено.' :
    !store.ready ? 'Проверяем вход…' : user ? 'Дневник сохраняется в аккаунте.' : 'Войди, чтобы сохранять дневник в аккаунте.';
  el('diary-storage').textContent = user ? 'Записи этого аккаунта. Для сохранения нужен интернет.' :
    'Гостевые записи остаются только в этом браузере.';
  el('dsave').disabled = !store.ready;
}

function applySession(session) {
  const previous = store.user?.id;
  store.setUser(session?.user || null);
  if (previous !== store.user?.id) {
    el('auth-password').value = '';
    el('auth-password-confirm').value = '';
    for (const id of ['dgood', 'dimp', 'dop', 'dsh', 'dg', 'dsa', 'dga']) el(id).value = '';
    el('dns').checked = false;
    window.mood = 0;
    window.rm();
    el('derr').textContent = '';
    el('dsum').textContent = '';
    el('dlist').textContent = '';
    window.dispatchEvent(new Event('goalie-account-change'));
  }
  renderAccount();
  window.dshow();
}

async function action(fn) {
  if (actionBusy) return;
  actionBusy = true;
  document.querySelectorAll('#account-panel button').forEach(b => { b.disabled = true; });
  message('Подождите…');
  try { await fn(); }
  catch (error) { message(error.message || 'Не удалось выполнить действие. Повтори попытку.'); }
  finally {
    actionBusy = false;
    document.querySelectorAll('#account-panel button').forEach(b => { b.disabled = false; });
  }
}

el('auth-form').addEventListener('submit', event => {
  event.preventDefault();
  action(async () => {
    const email = el('auth-email').value.trim();
    const password = el('auth-password').value;
    const signup = authMode === 'signup';
    if (signup && password !== el('auth-password-confirm').value) throw new Error('Пароли не совпадают. Проверь повтор пароля.');
    const { data, error } = signup
      ? await client.auth.signUp({ email, password })
      : await client.auth.signInWithPassword({ email, password });
    if (error) {
      const messages = {
        invalid_credentials: 'Неверная почта или пароль. Проверь их и попробуй снова.',
        email_not_confirmed: 'Адрес почты ещё не подтверждён. Вход пока недоступен.',
        user_already_exists: 'Аккаунт с этой почтой уже существует. Перейди на вкладку «Вход».',
        weak_password: 'Пароль слишком простой. Придумай более длинный пароль с буквами и цифрами.',
        signup_disabled: 'Регистрация пока закрыта.',
        over_request_rate_limit: 'Слишком много попыток. Подожди немного и повтори.'
      };
      throw new Error(messages[error.code] || 'Не удалось ' + (signup ? 'создать аккаунт' : 'войти') + '. Проверь соединение и попробуй позже.');
    }
    el('auth-password').value = '';
    el('auth-password-confirm').value = '';
    if (!data.session) {
      message('Для продолжения требуется подтверждение почты. Вход ещё не выполнен.');
      return;
    }
    applySession(data.session);
    const { error: profileError } = await client.from('profiles')
      .upsert({ id: data.user.id }, { onConflict: 'id', ignoreDuplicates: true });
    message(profileError ? 'Вход выполнен. Профиль пока не сохранён.' : 'Вход выполнен.');
  });
});

el('signout').onclick = () => action(async () => {
  const { error } = await client.auth.signOut({ scope: 'local' });
  if (error) throw new Error('Не удалось выйти. Повтори попытку.');
  applySession(null);
  setAuthMode('login');
  message('Вы вышли из аккаунта.');
});

el('import-local').onclick = () => action(async () => {
  const count = store.readLocal().length;
  if (!count) { message('На этом устройстве нет старых записей.'); return; }
  if (!window.confirm('Перенести ' + count + ' записей в аккаунт ' + store.user.email + '?')) {
    message('Перенос отменён.'); return;
  }
  const imported = await store.importLocal();
  await window.dshow();
  message('Перенос завершён: ' + imported + '. Повторный перенос не создаёт копии.');
});

el('diary-refresh').onclick = () => window.dshow();
renderAccount();
if (client) {
  let authEventReceived = false;
  client.auth.onAuthStateChange((_event, session) => {
    authEventReceived = true;
    applySession(session);
  });
  client.auth.getSession().then(({ data, error }) => {
    if (error) { message('Не удалось проверить вход. Обнови страницу.'); return; }
    if (!authEventReceived) applySession(data.session);
  }).catch(() => message('Не удалось проверить вход. Обнови страницу.'));
} else applySession(null);
