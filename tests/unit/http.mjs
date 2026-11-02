import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { readJson, readJsonStrict, matchRoute, err } from '../../apps/shared/http.mjs';

const body = value => Readable.from(value === null ? [] : [Buffer.from(value)]);
test('JSON parse policies preserve gateway tolerance and worker strictness', async () => {
  for (const parse of [readJson, readJsonStrict]) {
    assert.deepEqual(await parse(body(null)), {});
    assert.deepEqual(await parse(body('{"prompt":"中文"}')), {prompt:'中文'});
  }
  assert.deepEqual(await readJson(body('{broken')), {});
  await assert.rejects(readJsonStrict(body('{broken')), SyntaxError);
  for (const parse of [readJson, readJsonStrict]) {
    const request = Readable.from((async function* () { yield Buffer.from('{'); throw new Error('disconnected'); })());
    await assert.rejects(parse(request), /disconnected/);
  }
});
test('route matching keeps exact precedence, method isolation and decoded parameters', () => {
  const dynamic = () => {}, fixed = () => {};
  const routes = {'GET /jobs/:id':dynamic, 'GET /jobs/recent':fixed};
  assert.deepEqual(matchRoute(routes, 'GET', '/jobs/recent'), [fixed, {}]);
  assert.deepEqual(matchRoute(routes, 'GET', '/jobs/%E4%B8%AD%E6%96%87'), [dynamic, {id:'中文'}]);
  assert.deepEqual(matchRoute(routes, 'POST', '/jobs/x'), [null, null]);
  assert.deepEqual(matchRoute(routes, 'GET', '/jobs/x/events'), [null, null]);
});
test('API errors retain HTTP status, no-store and optional details', () => {
  let status, headers, payload;
  err({writeHead:(s,h)=>{status=s;headers=h},end:v=>payload=JSON.parse(v)},409,'BUSY','Wait',{job:'j'});
  assert.equal(status,409); assert.equal(headers['cache-control'],'no-store');
  assert.deepEqual(payload,{error:{code:'BUSY',message:'Wait',details:{job:'j'}}});
});
