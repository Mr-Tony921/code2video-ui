// Run copied into tests/integration so fixture imports always isolate user data.
import {TEST_TMP_ROOT} from '../fixtures.mjs';
import {execFileSync} from 'node:child_process';
import {readFileSync,statSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
process.env.CVW_INTERNAL_TOKEN='isolated-preview-test-token';
const {ensurePreview,previewCaps,previewIsFresh,previewUrlFor}=await import('../../apps/gateway/src/asset-preview.mjs');
const {probeVideo}=await import('../../apps/gateway/src/examples.mjs');
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
for(const [name,size,height] of [['coding_to_video','1920x1080',480],['experimental','1080x1920',480],['blockout_3d','1280x720',480],['already-small','640x360',360]]){
 const source=join(TEST_TMP_ROOT,name+'.mp4');
 execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i',`color=c=gray:s=${size}:r=24`,'-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','1','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-b:a','64k','-movflags','+faststart',source]);
 const original=await probeVideo(source),before=sha(source);assert(original.kbps<600,'The regression must exercise low-bitrate high-resolution input');
 const [a,b]=await Promise.all([ensurePreview(name,source),ensurePreview(name,source)]);assert(a);assert.deepEqual(a,b);
 assert.equal(sha(source),before,'Original bytes must not change');
 const output=await probeVideo(a.path??source);assert.equal(output.height,height);assert(output.width%2===0);
 assert.equal(a.mode,name==='already-small'?'none':'reencode');assert.equal(a.meta.caps,previewCaps());
 const fp={source_size:statSync(source).size,source_mtime_ms:Math.round(statSync(source).mtimeMs)};
 assert(previewIsFresh(a.meta,fp));assert(!previewIsFresh({...a.meta,caps:'480x600'},fp));
 assert(previewUrlFor(name).includes('v=v2%3A480x600'));
 if(a.path){assert(existsSync(a.path));assert(!a.path.includes('/sessions/'));assert.notEqual(a.path,source);}
 console.log(JSON.stringify({mode:name,original:size,preview:`${output.width}x${output.height}`,original_unchanged:true,coalesced:true}));
}
