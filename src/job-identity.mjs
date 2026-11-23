import {createRemoteJWKSet, jwtVerify} from 'jose';

const issuer = 'https://token.actions.githubusercontent.com';
const githubKeys = createRemoteJWKSet(new URL(issuer + '/.well-known/jwks'));
const repository = 'shushakovd83-jpg/bana';
const branch = 'refs/heads/main';
const workflow = repository + '/.github/workflows/booking-notifications.yml@' + branch;
const audience = 'https://vesna-banya-chaikovsky.almondmarmalade4.chatgpt.site/api/jobs/notifications';

export async function authorizedJob(header, keys = githubKeys) {
  if (!header?.startsWith('Bearer ') || header.length > 16384) return false;
  try {
    const {payload} = await jwtVerify(header.slice(7), keys, {
      issuer, audience,
      algorithms:['RS256'], requiredClaims:['iat','exp'], maxTokenAge:'10 minutes', clockTolerance:5
    });
    // Repository numeric ID, exact workflow and ref also support GitHub's immutable subject format.
    const trusted = payload.repository_id === '1468916528' && payload.repository === repository &&
      payload.workflow_ref === workflow && payload.ref === branch &&
      ['schedule','workflow_dispatch','push'].includes(payload.event_name);
    if (!trusted) console.warn('Booking job rejected: workflow identity mismatch');
    return trusted;
  } catch (error) {
    console.warn('Booking job token verification failed', error.code || error.name, error.claim || '');
    return false;
  }
}
