const communityChat = 'https://vk.me/nagore59';
const referencePattern = /^[A-Za-z0-9_-]{16,128}$/;

export function vkLink(token) {
  if (typeof token !== 'string' || !referencePattern.test(token)) throw new Error('Invalid booking reference');
  const url = new URL(communityChat);
  url.searchParams.set('ref', token);
  return url.href;
}

export class VKError extends Error {
  constructor(code) { super('VK API error ' + code); this.code = code; }
}

async function callVK(env, method, params) {
  if (!env.VK_TOKEN) throw new Error('VK token is not configured');
  const response = await fetch('https://api.vk.com/method/' + method, {
    method: 'POST', redirect: 'error',
    body: new URLSearchParams({...params, v:'5.199', access_token:env.VK_TOKEN}),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('VK HTTP ' + response.status);
  const result = await response.json();
  if (result.error) throw new VKError(Number(result.error.error_code));
  return result.response;
}

export async function resolveVKUser(env, name) {
  const users = await callVK(env, 'users.get', {user_ids:name});
  const id = users?.[0]?.id;
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('VK recipient not found');
  return id;
}

export async function sendVK(env, peer, text, randomId) {
  const peerId = Number(peer);
  if (!Number.isSafeInteger(peerId) || peerId <= 0) throw new Error('Invalid VK recipient');
  if (!Number.isInteger(randomId) || randomId === 0 || randomId < -2147483648 || randomId > 2147483647) {
    throw new Error('Invalid VK notification id');
  }
  const id = await callVK(env, 'messages.send', {peer_id:String(peerId), random_id:String(randomId), message:text});
  if (!Number.isSafeInteger(id) || id < 0) throw new Error('Missing VK message id');
  return id;
}

function reply(text, status = 200) {
  return new Response(text, {status, headers: {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store'}});
}

export async function callback(request, env, link) {
  if (request.method !== 'POST') return reply('POST required', 405);
  if (!env.VK_CALLBACK_SECRET || !/^[1-9]\d*$/.test(String(env.VK_GROUP_ID))) return reply('Callback unavailable', 503);
  let event;
  try {
    event = await request.json();
  } catch {
    return reply('Invalid JSON', 400);
  }
  if (event?.secret !== env.VK_CALLBACK_SECRET || String(event?.group_id) !== String(env.VK_GROUP_ID)) {
    return reply('Forbidden', 403);
  }
  if (event.type === 'confirmation') {
    return env.VK_CONFIRMATION ? reply(env.VK_CONFIRMATION) : reply('Confirmation unavailable', 503);
  }
  if (event.type === 'message_new') {
    const message = event.object?.message;
    const sender = message?.from_id;
    if (Number.isSafeInteger(sender) && sender > 0 && message.peer_id === sender &&
        !message.out && typeof message.ref === 'string' && referencePattern.test(message.ref)) {
      // link must record the first claimant atomically and tolerate VK event redelivery.
      await link(message.ref, sender);
    }
  }
  return reply('ok');
}
