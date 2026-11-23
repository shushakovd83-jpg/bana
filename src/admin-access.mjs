import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest();
const lifetime = 8 * 60 * 60 * 1000;

export function adminAccess(settings) {
  const accounts = [
    ['owner', settings.ADMIN_PASSWORD],
    ['staff', settings.STAFF_PASSWORD_1],
    ['staff', settings.STAFF_PASSWORD_2]
  ].filter(([, password]) => password);
  if (accounts.some(([, password]) => password.length < 16)) throw Error('Пароль журнала должен содержать минимум 16 символов.');
  const stored = accounts.map(([role, password]) => [role, digest(password)]);
  const sessions = new Map();
  const failures = new Map();
  function prune(map, now) {
    for (const [key, entry] of map) if (entry.until <= now) map.delete(key);
  }
  function signIn(password, address) {
    if (!settings.ADMIN_PASSWORD) throw Object.assign(Error('Владелец ещё не настроил вход в журнал.'), {status:503});
    const now = Date.now();
    prune(failures, now);
    prune(sessions, now);
    const attempt = failures.get(address) || {count:0, until:now+60000};
    if (attempt.count >= 20) throw Object.assign(Error('Слишком много попыток. Повторите через минуту.'), {status:429});
    const hash = digest(typeof password === 'string' ? password : '');
    const role = stored.find(([, expected]) => timingSafeEqual(hash, expected))?.[0];
    if (!role) {
      failures.set(address, {...attempt, count:attempt.count+1});
      throw Object.assign(Error('Проверьте пароль журнала.'), {status:401});
    }
    failures.delete(address);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, {role, until:now+lifetime});
    return {token, role};
  }
  function token(req) { return req.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]; }
  return {
    signIn, signOut(req) { sessions.delete(token(req)); },
    role(req) {
      const session = sessions.get(token(req));
      return session && session.until > Date.now() ? session.role : null;
    }
  };
}
