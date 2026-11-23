'use strict';

// Resolve configuration from the project's Pages directory, including on /bana/admin/.
const VesnaAPI = (() => {
  const locationOfConfig = new URL('api-config.json', document.currentScript.src);
  let ready;
  function checkedOrigin(value) {
    const url = new URL(value);
    const local = ['127.0.0.1','localhost'].includes(location.hostname) && ['127.0.0.1','localhost'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.origin !== value) {
      throw new Error('Адрес сервера указан неверно.');
    }
    return url.origin;
  }
  async function loadConfig() {
    const result = await fetch(locationOfConfig, {cache:'no-store', credentials:'omit'});
    if (!result.ok) throw new Error('Настройки сайта временно недоступны.');
    return result.json();
  }
  async function origin(path = '') {
    // A guest may have opened the form before the server cutover.
    const guest = path === '/api/bookings';
    if (!guest && !ready) ready = loadConfig().catch(error => {ready = undefined; throw error;});
    const config = guest ? await loadConfig() : await ready;
    const value = config.apiOrigin || (guest && config.bookingOriginDuringMigration);
    if (!value) throw new Error('Сервер онлайн-записи ещё не подключён.');
    return checkedOrigin(value);
  }
  async function request(path, options = {}) {
    return fetch(await origin(path) + path, {...options, credentials:'omit', redirect:'error', referrerPolicy:'no-referrer'});
  }
  return {request, origin};
})();
