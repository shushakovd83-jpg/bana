'use strict';

const form = document.querySelector('#request');
const fields = form.elements;
const requestPanel = document.querySelector('#message-panel');
const sendError = document.querySelector('#send-error');
const submitButton = form.querySelector('button[type="submit"]');
const dateInput = document.querySelector('#visit-date');
const timeInput = document.querySelector('#start-time');
const hoursInput = document.querySelector('#hours');
const currency = new Intl.NumberFormat('ru-RU', {
  style: 'currency', currency: 'RUB', maximumFractionDigits: 0
});
const localClock = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Yekaterinburg', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const deposit = 1000;
const closingTime = 23 * 60;

for (let count = 3; count <= 13; count++) {
  hoursInput.add(new Option(String(count), String(count), count === 3, count === 3));
}

function localNow() {
  const parts = Object.fromEntries(localClock.formatToParts(new Date()).map(part => [part.type, part.value]));
  return {day: [parts.year, parts.month, parts.day].join('-'), time: parts.hour + ':' + parts.minute};
}

function rentalPrice() {
  const hours = Number(hoursInput.value);
  return fields.tariff.value === 'barrel' ? 4500 + 1500 * hours : 1800 * hours;
}

function updateEstimate() {
  const price = rentalPrice();
  document.querySelector('#total').textContent = currency.format(price);
  document.querySelector('#balance').textContent = currency.format(price - deposit);
}

function startMinutes() {
  const [hour, minute] = timeInput.value.split(':').map(Number);
  return hour * 60 + minute;
}

function formatTime(minutes) {
  return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
}

function validateSlot() {
  const now = localNow();
  dateInput.min = now.day;
  timeInput.max = formatTime(closingTime - Number(hoursInput.value) * 60);
  timeInput.setCustomValidity('');
  if (timeInput.value && dateInput.value === now.day && timeInput.value <= now.time) {
    timeInput.setCustomValidity('Это время уже прошло. Выберите другое начало или другую дату.');
  } else if (timeInput.value && startMinutes() + Number(hoursInput.value) * 60 > closingTime) {
    timeInput.setCustomValidity('Баня работает до 23:00. Выберите более раннее начало или меньше часов.');
  }
}

function validatePhone() {
  const value = fields.phone.value.trim();
  const digits = value.replace(/\D/g, '');
  const acceptable = /^\+?[\d\s().-]+$/.test(value) && digits.length >= 10 && digits.length <= 15;
  fields.phone.setCustomValidity(value && !acceptable ? 'Введите номер телефона с кодом города или оператора.' : '');
}

function validateName() {
  fields.guestName.setCustomValidity(fields.guestName.value.trim() ? '' : 'Введите ваше имя.');
}

function bookingDetails() {
  return {
    day: dateInput.value,
    start: timeInput.value,
    hours: Number(hoursInput.value),
    guests: Number(fields.guests.value),
    guestName: fields.guestName.value.trim(),
    phone: fields.phone.value.trim(),
    tariff: fields.tariff.value
  };
}

dateInput.min = localNow().day;
dateInput.addEventListener('focus', validateSlot);
form.addEventListener('input', () => {
  updateEstimate();
  validateSlot();
  validatePhone();
  validateName();
});
// Keep the same request ID when retrying a submission after a network failure.
let pendingBooking = null;
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (submitButton.disabled) return;
  validateSlot();
  validatePhone();
  validateName();
  if (!form.reportValidity()) return;
  const booking = bookingDetails();
  const fingerprint = JSON.stringify(booking);
  sendError.textContent = '';
  submitButton.disabled = true;
  submitButton.textContent = 'Отправляем…';
  form.inert = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    if (!pendingBooking || pendingBooking.fingerprint !== fingerprint) {
      pendingBooking = {fingerprint, id: crypto.randomUUID()};
    }
    const response = await fetch('/api/bookings', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Accept': 'application/json'},
      body: JSON.stringify({...booking, id: pendingBooking.id}),
      signal: controller.signal
    });
    const result = await response.json();
    if (!response.ok) {
      sendError.textContent = result.error || 'Возникла ошибка при сохранении заявки. Повторите отправку.';
      return;
    }
    if (result.id !== pendingBooking.id) throw new Error('Missing receipt');
    const endTime = formatTime(startMinutes() + booking.hours * 60);
    const day = booking.day.split('-').reverse().join('.');
    document.querySelector('#receipt').textContent = day + ', ' + booking.start + '–' + endTime + '. Стоимость аренды — ' + currency.format(rentalPrice()) + '.';
    const chat = requestPanel.querySelector('a[href^="https://vk.me/"]');
    if (chat && result.vkUrl?.startsWith('https://vk.me/nagore59?ref=')) chat.href = result.vkUrl;
    form.hidden = true;
    requestPanel.hidden = false;
    requestPanel.querySelector('h3').focus();
  } catch {
    sendError.textContent = 'Подтверждение от сайта не получено. Проверьте соединение и повторите отправку.';
  } finally {
    clearTimeout(timer);
    form.inert = false;
    submitButton.disabled = false;
    submitButton.textContent = 'Отправить заявку';
  }
});
updateEstimate();

const photos = {
  steam: 'Парная с печью-каменкой',
  lounge: 'Комната отдыха',
  mirror: 'Зеркало с подсветкой и фен',
  barrel: 'Кедровая бочка'
};
const lightbox = document.querySelector('#photo');
const largePhoto = document.querySelector('#large-photo');
document.querySelectorAll('[data-photo]').forEach(button => {
  button.addEventListener('click', () => {
    const key = button.dataset.photo;
    largePhoto.src = 'assets/' + key + '.webp';
    largePhoto.alt = photos[key];
    document.querySelector('#photo-caption').textContent = photos[key];
    lightbox.setAttribute('aria-label', photos[key]);
    lightbox.showModal();
  });
});
lightbox.querySelector('.close').addEventListener('click', () => lightbox.close());
lightbox.addEventListener('click', event => {
  if (event.target === lightbox) lightbox.close();
});
