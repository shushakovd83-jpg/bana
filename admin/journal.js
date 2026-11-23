'use strict';

const entries = document.querySelector('#entries');
const template = document.querySelector('#entry-template');
const journalStatus = document.querySelector('#journal-status');
const reloadButton = document.querySelector('#reload');
const statusText = {new: 'Новая заявка', confirmed: 'Бронь подтверждена', cancelled: 'Бронь отменена'};
const money = new Intl.NumberFormat('ru-RU', {style: 'currency', currency: 'RUB', maximumFractionDigits: 0});
let busy = false;

const loginBox = document.querySelector('#login-box');
const journalContent = document.querySelector('#journal-content');
const loginForm = document.querySelector('#login-form');
const loginStatus = document.querySelector('#login-status');
let session = null;
function lockJournal(message = '') {
  session = null;
  entries.replaceChildren();
  document.querySelector('#vk-token').value = '';
  document.querySelector('#vk-result').textContent = '';
  journalContent.hidden = true;
  loginBox.hidden = false;
  loginStatus.textContent = message;
}
async function authorized(path, options = {}) {
  if (!session) throw new Error('Войдите в журнал.');
  const headers = new Headers(options.headers);
  headers.set('Authorization', 'Bearer ' + session.token);
  const response = await VesnaAPI.request(path, {...options,headers,cache:'no-store'});
  if (response.status === 401) lockJournal('Сеанс завершён. Введите пароль ещё раз.');
  return response;
}

function readableDay(day) {
  return String(day).split('-').reverse().join('.');
}
function formatTime(minutes) {
  return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
}
function describePrevious(previous) {
  if (typeof previous === 'string') return previous;
  if (previous && previous.day && previous.start) return readableDay(previous.day) + ', ' + previous.start;
  return '';
}

function buildEntry(row) {
  const item = template.content.firstElementChild.cloneNode(true);
  const hours = Number(row.hours);
  const [h, m] = row.start.split(':').map(Number);
  const end = formatTime(h * 60 + m + hours * 60);
  const withBarrel = row.tariff === 'barrel';
  const total = withBarrel ? 4500 + 1500 * hours : 1800 * hours;
  item.querySelector('.entry-title').textContent = row.guestName;
  const phone = document.createElement('a');
  phone.href = 'tel:' + String(row.phone).replace(/[^+0-9]/g, '');
  phone.textContent = row.phone;
  item.querySelector('.guest-info').append(phone);
  item.querySelector('.entry-time').textContent = readableDay(row.day) + ' · ' + row.start + '–' + end + ' · Гостей: ' + row.guests;
  item.querySelector('.entry-price').textContent = (withBarrel ? 'Баня с кедровой бочкой' : 'Только баня') + ' · ' + money.format(total);
  item.querySelector('.status-label').textContent = statusText[row.status] || row.status;
  const notice = item.querySelector('.entry-notice');
  if (row.notification === 'pending' || row.notification === 'sent') {
    notice.textContent = row.notification === 'sent' ? 'Уведомление о заявке отправлено в ВК.' : 'Уведомление о заявке в очереди на отправку.';
    notice.hidden = false;
  }
  const previous = describePrevious(row.previous);
  if (previous) {
    const previousText = item.querySelector('.previous');
    previousText.textContent = 'Прежнее время: ' + previous;
    previousText.hidden = false;
  }
  const editor = item.querySelector('form');
  const {day, start, status} = editor.elements;
  day.value = row.day;
  start.value = row.start;
  start.max = formatTime((23-hours)*60);
  status.value = row.status;
  editor.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !editor.reportValidity()) return;
    const output = editor.querySelector('.save-status');
    if (row.day === day.value && row.start === start.value && row.status === status.value) {
      output.textContent = 'Изменений нет.';
      return;
    }
    busy = true;
    reloadButton.disabled = true;
    entries.inert = true;
    output.textContent = 'Сохраняем изменения…';
    let saved = false;
    try {
      const response = await authorized('/api/admin', {
        method: 'POST', headers: {'Content-Type':'application/json', 'Accept':'application/json'},
        body: JSON.stringify({id:row.id,version:row.version,day:day.value,start:start.value,status:status.value})
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        output.textContent = result.error || (response.status === 409 ? 'Запись изменилась. Обновите журнал и проверьте актуальные данные.' : 'Не удалось сохранить изменения.');
        return;
      }
      saved = true;
      output.textContent = 'Изменения сохранены.';
      editor.querySelector('button').disabled = true;
    } catch {
      output.textContent = 'Подтверждение сохранения не получено. Обновите журнал, чтобы проверить запись.';
    } finally {
      busy = false;
      reloadButton.disabled = false;
      entries.inert = false;
    }
    if (saved) await refresh('Изменения сохранены.');
  });
  return item;
}

async function refresh(successText = '') {
  if (busy) return;
  busy = true;
  reloadButton.disabled = true;
  entries.inert = true;
  journalStatus.textContent = 'Загружаем заявки…';
  try {
    const response = await authorized('/api/admin', {cache:'no-store',headers:{'Accept':'application/json'}});
    if (!response.ok) {
      journalStatus.textContent = response.status === 401 || response.status === 403
        ? 'Для просмотра журнала нужен доступ администратора.' : 'Не удалось загрузить журнал. Нажмите «Обновить».';
      return;
    }
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Unexpected journal format');
    entries.replaceChildren(...rows.map(buildEntry));
    journalStatus.textContent = rows.length ? successText || 'Заявок в журнале: ' + rows.length : 'Заявок пока нет.';
  } catch {
    journalStatus.textContent = 'Не удалось получить журнал. Проверьте соединение и нажмите «Обновить».';
  } finally {
    busy = false;
    reloadButton.disabled = false;
    entries.inert = false;
  }
}
reloadButton.addEventListener('click', () => refresh());

const vkSettings = document.querySelector('#vk-settings');
const vkForm = document.querySelector('#vk-connect');
const vkState = document.querySelector('#vk-state');
const vkResult = document.querySelector('#vk-result');
const vkRetry = document.querySelector('#vk-retry');

async function vkRequest(path, input) {
  const options = {cache:'no-store'};
  if (input) Object.assign(options, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(input)});
  const response = await authorized(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Попробуйте ещё раз.');
  return data;
}

async function showVKStatus() {
  try {
    const {connected, pending} = await vkRequest('/api/admin/vk');
    vkState.textContent = (connected ? 'Получатель уведомлений — e.shushakov.' : 'Для отправки заявок подключите сообщество «Весна».') +
      (pending ? ' В очереди: ' + pending + '.' : '');
    vkRetry.hidden = !connected || !pending;
    if (!connected) vkSettings.open = true;
  } catch {
    vkState.textContent = 'Не удалось получить состояние подключения. Обновите страницу.';
  }
}

vkForm.addEventListener('submit', async event => {
  event.preventDefault();
  const input = vkForm.elements.token;
  const token = input.value.trim();
  if (!token || vkForm.inert) return;
  vkForm.inert = true;
  input.value = '';
  vkResult.textContent = 'Проверяем, принимает ли ВК сообщение…';
  try {
    await vkRequest('/api/admin/vk', {token});
    vkSettings.open = false;
    vkResult.textContent = 'ВК принял проверочное сообщение. Подключение сохранено.';
    await showVKStatus();
    await refresh();
  } catch (error) {
    vkResult.textContent = error.message || 'Не удалось подключить сообщество.';
  } finally {
    vkForm.inert = false;
  }
});

vkRetry.addEventListener('click', async () => {
  vkRetry.disabled = true;
  try {
    const result = await vkRequest('/api/admin/vk/retry', {});
    vkResult.textContent = 'Отправлено: ' + result.sent + '. Ошибок отправки: ' + result.failed + '.';
    await Promise.all([showVKStatus(), refresh()]);
  } catch { vkResult.textContent = 'Не удалось повторить отправку.'; }
  finally { vkRetry.disabled = false; }
});

reloadButton.addEventListener('click', () => { if (session?.role === 'owner') showVKStatus(); });

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  const input = document.querySelector('#journal-password');
  const password = input.value;
  if (!password || loginForm.inert) return;
  loginForm.inert = true;
  loginStatus.textContent = 'Проверяем пароль…';
  try {
    const response = await VesnaAPI.request('/api/session', {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password})});
    const result = await response.json();
    if (!response.ok || !result.token) throw new Error(result.error || 'Вход не выполнен.');
    session = result;
    input.value = '';
    loginBox.hidden = true;
    journalContent.hidden = false;
    document.querySelector('#vk').hidden = result.role !== 'owner';
    await Promise.all([refresh(), result.role === 'owner' ? showVKStatus() : undefined]);
  } catch (error) {
    loginStatus.textContent = error instanceof TypeError ? 'Не удалось связаться с сервером. Попробуйте ещё раз.' : error.message;
  } finally { loginForm.inert = false; }
});

document.querySelector('#logout').addEventListener('click', async () => {
  try {
    await authorized('/api/session', {method:'DELETE'});
    lockJournal();
  } catch {
    lockJournal('Вы вышли из журнала на этом устройстве.');
  }
});
document.querySelector('#excel').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await authorized('/api/export.xlsx');
    if (!response.ok) throw new Error('Не удалось загрузить Excel.');
    const link = document.createElement('a');
    const url = URL.createObjectURL(await response.blob());
    link.href = url;
    link.download = 'Весна — бронирования.xlsx';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch { journalStatus.textContent = 'Не удалось скачать таблицу. Попробуйте ещё раз.'; }
  finally { button.disabled = false; }
});

VesnaAPI.origin().then(() => {
  loginForm.querySelector('button').disabled = false;
}).catch(() => {
  document.querySelector('#journal-password').disabled = true;
  loginStatus.textContent = 'Журнал откроется после подключения сервера Amvera.';
});
