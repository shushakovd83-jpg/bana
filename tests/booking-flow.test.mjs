import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {test} from 'node:test';
import worker from '../src/server.mjs';
import {adminAccess} from '../src/admin-access.mjs';

const journal = 'private/journal-v1.json';
const workbook = 'private/vesna.xlsx';
const settings = 'private/settings/vk.json';
const origin = 'https://shushakovd83-jpg.github.io';
const ownerPassword = 'example-password-for-local-tests';

class TestBucket {
  objects = new Map();
  async head(path) {
    return this.objects.get(path) || null;
  }
  async get(path) {
    const obj = await this.head(path);
    return obj && {...obj, json: () => JSON.parse(obj.body.toString())};
  }
  async put(path, value, {onlyIf, customMetadata} = {}) {
    const existing = this.objects.get(path);
    if (onlyIf?.etagMatches && onlyIf.etagMatches !== existing?.etag) return null;
    if (onlyIf?.etagDoesNotMatch === '*' && existing) return null;
    const body = Buffer.from(value);
    const obj = {body, etag:createHash('md5').update(body).digest('hex'), customMetadata};
    this.objects.set(path, obj);
    return obj;
  }
}

function setup() {
  const access = adminAccess({ADMIN_PASSWORD:ownerPassword});
  const owner = {authorization:'Bearer ' + access.signIn(ownerPassword,'local').token};
  const env = {BUCKET:new TestBucket(), ACCESS:access,
    VK_SETTINGS_KEY:Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')};
  const work = [];
  const ctx = {waitUntil(promise) { work.push(promise); }};
  const call = (path, data, headers = {}) => worker.fetch(new Request(new URL(path, 'https://site.example.test'), {
    method:data ? 'POST' : 'GET',
    headers:{'content-type':'application/json', ...headers},
    body:data ? JSON.stringify(data) : undefined
  }), env, ctx);
  return {env, owner, call, settle:() => Promise.all(work.splice(0))};
}

function booking() {
  return {id:randomUUID(), day:'2099-03-05', start:'17:00', hours:3, guests:8, tariff:'barrel',
    guestName:'Тестовый гость', phone:'+7 (000) 000-00-00'};
}

test('Pages submission persists a private, downloadable Excel row and tolerates a repeated receipt', async () => {
  const {env, owner, call, settle} = setup();
  const data = booking();
  for (let i = 0; i < 2; i++) {
    const response = await call('/api/bookings', data, {origin});
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.deepEqual(await response.json(), {id:data.id});
    const file = await env.BUCKET.get(workbook);
    assert.equal(file.body.toString('ascii',0,2), 'PK');
    assert.ok(file.body.includes(Buffer.from(data.guestName)));
    await settle();
  }
  const rows = (await env.BUCKET.get(journal)).json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].events.length, 1);
  assert.equal((await call('/api/bookings', {...data, guests:9}, {origin})).status, 409);
  assert.equal((await call('/api/bookings', {...booking(), guests:13}, {origin})).status, 400);
  assert.equal((await call('/api/bookings', {...booking(), hours:2}, {origin})).status, 400);
  for (const path of ['/api/admin', '/api/export.xlsx', '/api/admin/vk', '/api/admin/vk/retry']) {
    assert.equal((await call(path)).status, 401);
  }
  assert.equal((await call('/api/admin/vk', {token:'test'}, {origin})).status, 401);
  const exported = await call('/api/export.xlsx', null, owner);
  assert.match(exported.headers.get('content-type'), /spreadsheetml/);
  assert.deepEqual(Buffer.from(await exported.arrayBuffer()), (await env.BUCKET.get(workbook)).body);
  const change = {id:data.id, version:1, day:'2099-04-20', start:'18:00', status:'confirmed'};
  assert.equal((await call('/api/admin', change, owner)).status, 200);
  assert.equal((await call('/api/admin', change, owner)).status, 200);
  await settle();
  const updated = (await env.BUCKET.get(workbook)).body;
  for (const value of ['Подтверждена','2099-03-05 17:00','<v>9000</v>','<v>1000</v>','<v>8000</v>']) {
    assert.ok(updated.includes(Buffer.from(value)), value);
  }
});

test('VK verifies the recipient, then drains queued bookings and retries a failure with the same VK id', async t => {
  const {call, env, owner, settle} = setup();
  const first = booking();
  const token = 'community-token-for-this-test';
  const sent = [], attempts = [];
  let failure = false;
  t.mock.method(globalThis, 'fetch', async (url, {body}) => {
    assert.equal(body.get('access_token'), token);
    if (String(url).endsWith('/users.get')) {
      assert.equal(body.get('user_ids'), 'e.shushakov');
      return Response.json({response:[{id:12345}]});
    }
    assert.match(String(url), /\/messages\.send$/);
    assert.equal(body.get('peer_id'), '12345');
    const event = {n:body.get('random_id'), text:body.get('message')};
    attempts.push(event);
    if (failure) return Response.json({error:{error_code:901}});
    sent.push(event);
    return Response.json({response:sent.length});
  });
  assert.equal((await call('/api/bookings', first, {origin})).status, 201);
  await settle();
  assert.equal(attempts.length, 0);
  assert.deepEqual(await (await call('/api/admin/vk', null, owner)).json(), {connected:false, pending:1});
  failure = true;
  assert.equal((await call('/api/admin/vk', {token}, owner)).status, 422);
  assert.equal(await env.BUCKET.get(settings), null);
  failure = false;
  assert.equal((await call('/api/admin/vk', {token}, owner)).status, 200);
  await settle();
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /Проверка связи/);
  for (const detail of [first.guestName, first.phone, '05.03.2099', '17:00–20:00', 'Гостей: 8', '9000 ₽']) {
    assert.ok(sent[1].text.includes(detail), detail);
  }
  assert.ok(!(await env.BUCKET.get(settings)).body.includes(Buffer.from(token)));
  const second = {...booking(), guestName:'Следующая заявка'};
  failure = true;
  assert.equal((await call('/api/bookings', second, {origin})).status, 201);
  await settle();
  const unsuccessful = attempts.at(-1);
  assert.match(unsuccessful.text, /Следующая заявка/);
  const before = await (await call('/api/admin', null, owner)).json();
  assert.equal(before.find(row => row.id === second.id).notification, 'pending');
  assert.ok(!before.some(row => ('events' in row) || ('token' in row)));
  failure = false;
  assert.deepEqual(await (await call('/api/admin/vk/retry', {}, owner)).json(), {connected:true,sent:1,failed:0});
  assert.equal(sent.at(-1).n, unsuccessful.n);
  assert.equal((await call('/api/bookings', second, {origin})).status, 201);
  await settle();
  assert.equal(sent.length, 3);
  assert.deepEqual(await (await call('/api/admin/vk', null, owner)).json(), {connected:true,pending:0});
});

test('a failed workbook write can be retried and simultaneous submissions leave every booking in Excel', async t => {
  const {env, call, settle} = setup();
  const original = env.BUCKET.put.bind(env.BUCKET);
  let failNext = true;
  t.mock.method(env.BUCKET, 'put', async (path, ...params) => {
    if (path === workbook && failNext) {
      failNext = false;
      throw new Error('Temporary storage error');
    }
    return original(path, ...params);
  });
  const first = booking();
  assert.equal((await call('/api/bookings', first, {origin})).status, 503);
  assert.equal(await env.BUCKET.head(workbook), null);
  const group = [first, booking(), booking(), booking()];
  const responses = await Promise.all(group.map(data => call('/api/bookings', data, {origin})));
  assert.ok(responses.every(response => response.status === 201));
  await settle();
  const savedRows = (await env.BUCKET.get(journal)).json();
  assert.equal(savedRows.length, 4);
  const file = await env.BUCKET.get(workbook);
  assert.equal(file.customMetadata.journal, (await env.BUCKET.head(journal)).etag);
  for (const {id} of group) assert.ok(file.body.includes(Buffer.from(id)), id);
});

test('the service can refresh the workbook on its own and admin access requires the journal password', async () => {
  const {call, env} = setup();
  assert.equal((await call('/api/export.xlsx', null, {'oai-authenticated-user-id':'owner'})).status,401);
  const login = await call('/api/session', {password:ownerPassword}, {origin});
  assert.equal(login.status,200);
  const {role,token} = await login.json();
  assert.equal(role,'owner');
  assert.equal((await call('/api/admin', null, {authorization:'Bearer '+token,origin})).status,200);
  assert.deepEqual(await worker.scheduled(null, env), {connected:false,sent:0,failed:0});
  assert.ok((await env.BUCKET.get(workbook)).body.includes(Buffer.from('xl/tables/table1.xml')));
});
