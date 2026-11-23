import {resolveVKUser, sendVK, VKError} from './vk.mjs';

const settingsPath = 'private/settings/vk.json';
const adminName = 'e.shushakov';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const context = encoder.encode('vesna/vk-settings/v1');
const bytes = value => Uint8Array.from(atob(value), ch => ch.charCodeAt(0));
const base64 = value => btoa(String.fromCharCode(...new Uint8Array(value)));

async function encryptionKey(env) {
  if (!env.VK_SETTINGS_KEY) throw new Error('Missing encryption key');
  return crypto.subtle.importKey('raw', bytes(env.VK_SETTINGS_KEY), 'AES-GCM', false, ['encrypt','decrypt']);
}

export async function vkCredentials(env) {
  const obj = await env.BUCKET.get(settingsPath);
  if (!obj) return env.VK_TOKEN && env.VK_ADMIN_PEER ? {VK_TOKEN:env.VK_TOKEN, VK_ADMIN_PEER:env.VK_ADMIN_PEER} : null;
  const sealed = await obj.json();
  const plain = await crypto.subtle.decrypt({name:'AES-GCM', iv:bytes(sealed.iv), additionalData:context},
    await encryptionKey(env), bytes(sealed.data));
  return JSON.parse(decoder.decode(plain));
}

export async function setVKToken(env, token) {
  if (typeof token !== 'string' || !token.trim() || token.length > 2048 || /\s/.test(token.trim())) {
    throw Object.assign(new Error('Проверьте ключ сообщества.'), {status:400});
  }
  const key = await encryptionKey(env);
  const credentials = {VK_TOKEN: token.trim()};
  try {
    credentials.VK_ADMIN_PEER = String(await resolveVKUser(credentials, adminName));
    const randomId = crypto.getRandomValues(new Uint32Array(1))[0] % 2147483646 + 1;
    await sendVK(credentials, credentials.VK_ADMIN_PEER,
      'Баня «Весна». Проверка связи: сюда будут приходить уведомления о заявках с сайта.', randomId);
  } catch (e) {
    let hint = 'ВК не подтвердил отправку. Проверьте ключ и повторите подключение.';
    if ([901,902].includes(e.code)) hint = 'Разрешите сообщения: напишите «Начать» в сообщество nagore59 с профиля e.shushakov и повторите подключение.';
    if ([5,7,15,27,28].includes(e.code)) hint = 'Проверьте, что это действующий ключ сообщества с правом на сообщения.';
    if (e instanceof VKError) hint += ' Код ВК: ' + e.code + '.';
    throw Object.assign(new Error(hint), {status:422});
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({name:'AES-GCM', iv, additionalData:context},
    key, encoder.encode(JSON.stringify(credentials)));
  await env.BUCKET.put(settingsPath, JSON.stringify({iv:base64(iv), data:base64(ciphertext)}));
  return credentials;
}
