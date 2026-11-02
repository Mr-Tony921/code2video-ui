import '../fixtures.mjs';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
process.env.CVW_INTERNAL_TOKEN = 'unit-test-only-internal-token';
process.env.CVW_SESSION_SECRET = 'unit-test-only-session-secret';
const { setSessionCookie, currentUser, internalAuthed } = await import('../../apps/gateway/src/auth.mjs');
const req = cookie => ({headers:{cookie}});
test('ordinary signed session roundtrip, tampering, expiry and cookie isolation', () => {
  let cookie;
  setSessionCookie({setHeader:(k,v)=>cookie=v},{id:'test',username:'test',role:'user',can_use_blockout_3d:false});
  assert.match(cookie,/^cvw_codex_session=/);
  assert.match(cookie,/HttpOnly/);
  assert.equal(currentUser(req(cookie)).role,'user');
  assert.equal(currentUser(req(cookie.replace('cvw_codex_session','cvw_session'))),null);
  assert.equal(currentUser(req('cvw_codex_session=forged.invalid')),null);
  assert.equal(currentUser(req(undefined)),null);
  const expired=Buffer.from(JSON.stringify({id:'test',exp:Date.now()-1000})).toString('base64url');
  const sig=createHmac('sha256',process.env.CVW_SESSION_SECRET).update(expired).digest('base64url');
  assert.equal(currentUser(req(`cvw_codex_session=${expired}.${sig}`)),null);
});
test('internal auth requires both trusted source and exact token', () => {
  const internal = (ip,token) => ({socket:{remoteAddress:ip},headers:{'x-internal-token':token}});
  assert.equal(internalAuthed(internal('::ffff:10.120.3.60',process.env.CVW_INTERNAL_TOKEN)),true);
  assert.equal(internalAuthed(internal('10.120.3.60','wrong')),false);
  assert.equal(internalAuthed(internal('203.0.113.5',process.env.CVW_INTERNAL_TOKEN)),false);
});
