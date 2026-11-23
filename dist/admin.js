'use strict';

const entries = document.querySelector('#entries');
const template = document.querySelector('#entry-template');
const journalStatus = document.querySelector('#journal-status');
const reloadButton = document.querySelector('#reload');
const statusText = {new: 'Новая заявка', confirmed: 'Бронь подтверждена', cancelled: 'Бронь отменена'};
const money = new Intl.NumberFormat('ru-RU', {style: 'currency', currency: 'RUB', maximumFractionDigits: 0});
let busy = false;

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
      const response = await fetch('/api/admin', {
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
    const response = await fetch('/api/admin', {cache:'no-store',headers:{'Accept':'application/json'}});
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
refresh();
