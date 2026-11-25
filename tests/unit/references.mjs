import '../fixtures.mjs';
import { TEST_TMP_ROOT } from '../fixtures.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
process.env.CVW_GATEWAY_BASE_URL = 'http://127.0.0.1:1';
process.env.CVW_INTERNAL_TOKEN = 'reference-fixture-token';
const { upsertSessionMeta } = await import('../../apps/worker-bridge/src/session-store.mjs');
const { referencesDir } = await import('../../apps/worker-bridge/src/session-workspace.mjs');
const { addReference, removeReference, freezeReferences, referenceManifest, readManifest } = await import('../../apps/worker-bridge/src/references.mjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=', 'base64');
const hash = x => createHash('sha256').update(x).digest('hex');
async function session(mode) {
 const sid = 'sess_' + randomUUID();
 await upsertSessionMeta({sessionId:sid, userId:'test-fixture', mode}); return sid;
}
async function input(filename='same.png') {
 const tmpPath = join(TEST_TMP_ROOT,randomUUID()); await writeFile(tmpPath,png);return {filename,tmpPath};
}
test('100 whitebox images survive concurrent uploads in order; 101st rejects without overwriting originals', async () => {
 const sid = await session('blockout_3d');
 const files = await Promise.all(Array.from({length:101}, () => input()));
 let reading=true, snapshots=[];
 const reader=(async()=>{while(reading){snapshots.push((await readManifest(sid)).items.length);await new Promise(r=>setTimeout(r,10));}})();
 const results=await Promise.allSettled(files.map(f=>addReference(sid,f)));reading=false;await reader;
 assert.equal(results.filter(x=>x.status==='fulfilled').length,100);
 assert.equal(results[100].reason.code,'REFERENCE_LIMIT_EXCEEDED');
 const m=await referenceManifest(sid);assert.equal(m.max_per_session,100);assert.equal(m.remaining,0);assert.equal(m.items.length,100);
 assert.equal(new Set(m.items.map(x=>x.stored_name)).size,100);
 assert.deepEqual(m.items.map(x=>x.stored_name),results.slice(0,100).map(x=>x.value.item.stored_name));
 assert.ok(snapshots.every((n,i)=>i===0||n>=snapshots[i-1]),'atomic manifest reads never transiently reset');
 for(const item of m.items)assert.equal(hash(await readFile(join(referencesDir(sid),item.stored_name))),hash(png));
 assert.equal(m.items[0].meta.width,1);assert.equal(m.items[0].meta.height,1);
 await removeReference(sid,m.items[0].stored_name);assert.equal((await referenceManifest(sid)).remaining,1);
 await addReference(sid,await input('replacement.png'));assert.equal((await readManifest(sid)).items.length,100);
});
test('C2V and experimental stay at 10 even if an upload claims whitebox mode',async()=>{
 for(const mode of ['coding_to_video','experimental']) {
  const sid=await session(mode),inputs=await Promise.all(Array.from({length:11},()=>input()));
  const results=await Promise.allSettled(inputs.map(f=>addReference(sid,{...f,mode:'blockout_3d'})));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,10);assert.equal(results[10].reason.code,'REFERENCE_LIMIT_EXCEEDED');
  const m=await referenceManifest(sid);assert.equal(m.max_per_session,10);assert.equal(m.remaining,0);
 }
 assert.equal((await referenceManifest('sess_'+randomUUID())).max_per_session,10);
});
test('freeze serializes with upload and prevents subsequent additions or removal',async()=>{
 const sid=await session('blockout_3d'),a=await input('a.png'),b=await input('b.png');
 const results=await Promise.allSettled([addReference(sid,a),freezeReferences(sid),addReference(sid,b)]);
 assert.equal(results[0].status,'fulfilled');assert.equal(results[1].value.items.length,1);assert.equal(results[2].reason.code,'REFERENCES_FROZEN');
 await assert.rejects(removeReference(sid,'a.png'),e=>e.code==='REFERENCES_FROZEN');
 const m=await referenceManifest(sid);assert.equal(m.items.length,1);assert.equal(m.frozen,true);
});
test('whitebox unsupported formats fail at upload rather than disappearing from model evidence',async()=>{
 const sid=await session('blockout_3d');
 for(const name of ['movie.mp4','sound.wav','animation.gif','scan.bmp'])await assert.rejects(addReference(sid,await input(name)),e=>e.code==='REFERENCE_TYPE_UNSUPPORTED');
 assert.equal((await readManifest(sid)).items.length,0);
});

test('temporary experimental allowlist accepts 25 images only for its session and expires safely',async()=>{
 const { config } = await import('../../apps/worker-bridge/src/config.mjs');
 const { referenceLimit } = await import('../../apps/worker-bridge/src/references.mjs');
 const sid=await session('experimental'),previous=config.raw.references.experimental_session_limits;
 config.raw.references.experimental_session_limits={
  [sid]:{max_per_session:25,expires_at:new Date(Date.now()+60000).toISOString()}
 };
 try {
  assert.equal(referenceLimit('experimental',sid),25);
  assert.equal(referenceLimit('experimental','different-session'),10);
  assert.equal(referenceLimit('coding_to_video',sid),10);
  assert.equal(referenceLimit('blockout_3d',sid),100);
  assert.equal(referenceLimit('experimental',sid,Date.now()+120000),10);
  const files=await Promise.all(Array.from({length:26},()=>input()));
  const results=await Promise.allSettled(files.map(f=>addReference(sid,f)));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,25);
  assert.equal(results[25].reason.code,'REFERENCE_LIMIT_EXCEEDED');
  assert.equal((await referenceManifest(sid)).max_per_session,25);
  await freezeReferences(sid);
  config.raw.references.experimental_session_limits[sid].expires_at='2000-01-01T00:00:00Z';
  const m=await referenceManifest(sid);
  assert.equal(m.items.length,25);assert.equal(m.max_per_session,10);assert.equal(m.remaining,0);
  await assert.rejects(addReference(sid,await input()),e=>e.code==='REFERENCES_FROZEN');
  for(const limit of [101,25.5,'25',null]){
   config.raw.references.experimental_session_limits[sid]={max_per_session:limit,expires_at:'2099-01-01T00:00:00Z'};
   assert.equal(referenceLimit('experimental',sid),10);
  }
 } finally {
  if(previous===undefined)delete config.raw.references.experimental_session_limits;
  else config.raw.references.experimental_session_limits=previous;
 }
});
