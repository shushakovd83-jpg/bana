import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair, SignJWT} from 'jose';
import {authorizedJob} from '../src/job-identity.mjs';
import worker from '../src/server.mjs';

test('only the repository notification workflow on main can run delivery', async () => {
  const keys = await generateKeyPair('RS256');
  const audience = 'https://vesna-banya-chaikovsky.almondmarmalade4.chatgpt.site/api/jobs/notifications';
  const payload = {repository:'shushakovd83-jpg/bana', repository_id:'1468916528', ref:'refs/heads/main', event_name:'schedule',
    workflow_ref:'shushakovd83-jpg/bana/.github/workflows/booking-notifications.yml@refs/heads/main'};
  async function header(change = {}, aud = audience) {
    const token = await new SignJWT({...payload, ...change}).setProtectedHeader({alg:'RS256'})
      .setSubject('repo:shushakovd83-jpg/bana:ref:refs/heads/main').setAudience(aud)
      .setIssuer('https://token.actions.githubusercontent.com').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
    return 'Bearer ' + token;
  }
  assert.equal(await authorizedJob(await header(), keys.publicKey), true);
  for (const change of [{ref:'refs/heads/demo'},{repository_id:'9'},{repository:'some/other-repo'},{event_name:'pull_request'},{workflow_ref:'other'}]) {
    assert.equal(await authorizedJob(await header(change), keys.publicKey), false);
  }
  assert.equal(await authorizedJob(await header({}, 'other-audience'), keys.publicKey), false);
  assert.equal(await authorizedJob('', keys.publicKey), false);
  const anonymous = await worker.fetch(new Request(audience, {method:'POST'}), {}, {});
  assert.equal(anonymous.status, 401);
});
