import {writeFile} from 'node:fs/promises';

const endpoint = new URL(process.argv[2]);
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
  throw Error('Укажите публичный HTTPS-адрес приложения без пути.');
}
const origin = 'https://shushakovd83-jpg.github.io';
const probe = (path, options = {}) => fetch(new URL(path, endpoint), {headers:{Origin:origin, ...options.headers}, ...options,
  redirect:'error', signal:AbortSignal.timeout(15000)});
const response = await probe('/health');
if (!response.ok || response.headers.get('access-control-allow-origin') !== origin) throw Error('Сервер ещё не разрешил доступ с GitHub Pages.');
const state = await response.json();
if (!state.ready || state.service !== 'vesna-bookings') throw Error('По этому адресу не запущен сервер «Весны».');
const preflight = await probe('/api/bookings', {method:'OPTIONS'});
if (preflight.status !== 204 || !preflight.headers.get('access-control-allow-methods')?.includes('POST')) throw Error('Форма пока не может отправлять заявки.');
for (const path of ['/api/admin','/api/export.xlsx']) {
  if ((await probe(path)).status !== 401) throw Error('Сервер не подтвердил защиту журнала.');
}
await writeFile(new URL('../api-config.json', import.meta.url), JSON.stringify({apiOrigin:endpoint.origin}, null, 2)+'\n');
console.log('Сервер проверен. Адрес для GitHub Pages сохранён в api-config.json.');
