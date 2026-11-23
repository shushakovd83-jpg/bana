const communityChat = 'https://vk.me/nagore59';
const referencePattern = /^[A-Za-z0-9_-]{16,128}$/;

export function vkLink(token) {
  if (typeof token !== 'string' || !referencePattern.test(token)) throw new Error('Invalid booking reference');
  const url = new URL(communityChat);
  url.searchParams.set('ref', token);
  return url.href;
}

// Supply the same nonzero signed 32-bit random_id on retries of this notification.
export async function sendVK(env, peer, text, randomId) {
  if (!env.VK_TOKEN) throw new Error('VK token is not configured');
  const peerId = Number(peer);
  if (!Number.isSafeInteger(peerId) || peerId <= 0) throw new Error('Invalid VK recipient');
  if (!Number.isInteger(randomId) || randomId === 0 || randomId < -2147483648 || randomId > 2147483647) {
    throw new Error('Invalid VK notification id');
  }
  if (typeof text !== 'string' || !text.trim()) throw new Error('Empty VK message');
  const response = await fetch('https://api.vk.com/method/messages.send', {
    method: 'POST',
    redirect: 'error',
    headers: {Authorization: 'Bearer ' + env.VK_TOKEN},
    body: new URLSearchParams({
      v: '5.199',
      peer_id: String(peerId),
      random_id: String(randomId),
      message: text
    }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('VK HTTP ' + response.status);
  const result = await response.json();
  if (result.error || !Number.isSafeInteger(result.response)) {
    const code = Number(result.error?.error_code);
    throw new Error(Number.isSafeInteger(code) ? 'VK API error ' + code : 'Unexpected VK API response');
  }
  return result.response;
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
