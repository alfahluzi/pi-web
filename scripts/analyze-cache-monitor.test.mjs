import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const analyzer=path.resolve('scripts/analyze-cache-monitor.mjs');
const epoch='00000000-0000-4000-8000-000000000001', stream='00000000-0000-4000-8000-000000000002';
const hash='a'.repeat(64), prompt='b'.repeat(64), now=Date.now();
function record(index,type,extra={}) { return {schema_version:1,local_epoch_id:epoch,local_invocation_id:`00000000-0000-4000-8000-${String(index+3).padStart(12,'0')}`,local_stream_id:stream,sequence:index*2+(type==='response'?1:0),invocation_index:index,timestamp_ms:now-1000,provider:'openai',model_id_hash:hash,config_id_hash:hash,event_type:type,association:'paired',fingerprints:{prompt:type==='request'?{hmac_sha256:prompt,bytes:20,complete:true}:null},usage:type==='response'?{input_tokens:100,output_tokens:5,cache_read_tokens:0,cache_write_tokens:null}:null,incomplete:false,...extra}; }
async function run(records, mutate, fixedNow) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'cache-monitor-'));
 try { await writeFile(path.join(dir,'capture.jsonl'),records.map(x=>JSON.stringify(x)).join('\n')+'\n'); if(mutate) await mutate(dir); const args=fixedNow===undefined?[analyzer,dir]:['--import',`data:text/javascript,Date.now=()=>${fixedNow}`,analyzer,dir]; return spawnSync(process.execPath,args,{encoding:'utf8'}); }
 finally { await rm(dir,{recursive:true,force:true}); }
}
test('pairs exact local tuples and reports fixed labels only',async()=>{
 const result=await run([record(0,'request'),record(0,'response'),record(1,'request'),record(1,'response')]);
 assert.equal(result.status,0); const report=JSON.parse(result.stdout);
 assert.equal(report.labels.unchanged_observed_payload_low_cache_upstream_or_unobserved,1);
 assert.equal(Object.keys(report.labels).length,9); assert.doesNotMatch(result.stdout,/00000000|aaaa|openai|prompt/);
});
test('changed request fingerprints count delta',async()=>{
 const second=record(1,'request'); second.fingerprints.prompt.hmac_sha256='c'.repeat(64);
 const result=await run([record(0,'request'),record(0,'response'),second,record(1,'response')]);
 assert.equal(JSON.parse(result.stdout).labels.observed_client_payload_delta,1);
});
test('missing response and ambiguous retries produce labels',async()=>{
 let result=await run([record(0,'request')]); assert.equal(JSON.parse(result.stdout).labels.unmatched_response,1);
 const repeated=record(0,'request'); repeated.sequence=2;
 result=await run([record(0,'request'),repeated,record(0,'response')]); assert.equal(JSON.parse(result.stdout).labels.retry_ambiguous,1);
});
test('rejects extra schema fields and invalid field types without stdout',async()=>{
 for(const bad of [{...record(0,'request'),extra:true},{...record(0,'request'),sequence:'0'},{...record(0,'request'),provider:null}]) {
  const result=await run([bad]); assert.notEqual(result.status,0); assert.equal(result.stdout,'');
 }
});
test('accepts aggregate capture exactly at and near the total cap, rejects over cap',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'cache-monitor-'));
 try {
  const row=JSON.stringify(record(0,'unknown',{association:'unmatched'}));
  const lineFor=(seq)=>JSON.stringify({...record(seq,'unknown',{association:'unmatched'}),sequence:seq});
  const payload=size=>{let out='',seq=0; while(out.length<size){const line=lineFor(seq++); const len=Math.min(16384,size-out.length); if(len<Buffer.byteLength(line)+1) throw new Error('fixture remainder too small'); out+=line+' '.repeat(len-Buffer.byteLength(line)-1)+'\n';} return out;};
  const near=899613;
  for(let i=0;i<4;i++) await writeFile(path.join(dir,`part${i}`),payload(near));
  let result=spawnSync(process.execPath,[analyzer,dir],{encoding:'utf8'}); assert.equal(result.status,0,result.stderr);
  const max=1024*1024;
  for(let i=0;i<4;i++) await writeFile(path.join(dir,`part${i}`),payload(max));
  result=spawnSync(process.execPath,[analyzer,dir],{encoding:'utf8'}); assert.equal(result.status,0,result.stderr);
  for(let i=0;i<5;i++) await writeFile(path.join(dir,`over${i}`),payload(838861));
  result=spawnSync(process.execPath,[analyzer,dir],{encoding:'utf8'}); assert.notEqual(result.status,0); assert.equal(result.stdout,'');
 } finally { await rm(dir,{recursive:true,force:true}); }
});
test('rejects file, line, aggregate and directory limits without stdout',async()=>{
 for(const mutate of [async dir=>writeFile(path.join(dir,'capture.jsonl'),Buffer.alloc(1024*1024+1)),async dir=>writeFile(path.join(dir,'capture.jsonl'),'x'.repeat(16*1024)+'\\n'),async dir=>{for(let i=0;i<5;i++) await writeFile(path.join(dir,`f${i}`),Buffer.alloc(1024*1024));},async dir=>{for(let i=0;i<17;i++) await writeFile(path.join(dir,`f${i}`),'x');}]) {
  const result=await run([record(0,'request')],mutate); assert.notEqual(result.status,0); assert.equal(result.stdout,'');
 }
});
test('rejects malformed and oversized data without partial output',async()=>{
 let result=await run([record(0,'request')],async dir=>writeFile(path.join(dir,'capture.jsonl'),'{}\n'));
 assert.notEqual(result.status,0); assert.equal(result.stdout,'');
 const dir=await mkdtemp(path.join(os.tmpdir(),'cache-monitor-'));
 try { await writeFile(path.join(dir,'big'),Buffer.alloc(1024*1024+1)); result=spawnSync(process.execPath,[analyzer,dir],{encoding:'utf8'}); assert.notEqual(result.status,0); assert.equal(result.stdout,''); }
 finally { await rm(dir,{recursive:true,force:true}); }
});
test('accepts only complete unknown zero-UUID sentinel',async()=>{
 const sentinel={...record(0,'unknown'),local_invocation_id:'00000000-0000-0000-0000-000000000000',local_stream_id:'00000000-0000-0000-0000-000000000000',association:'unmatched'};
 const result=await run([sentinel]); assert.equal(result.status,0);
 for(const bad of [{...sentinel,event_type:'request'},{...sentinel,local_stream_id:stream},{...sentinel,local_epoch_id:'00000000-0000-0000-0000-000000000000'},{...sentinel,local_invocation_id:4}]) {
  const rejected=await run([bad]); assert.notEqual(rejected.status,0); assert.equal(rejected.stdout,'');
 }
});
test('rejects future and exact retention-boundary timestamps',async()=>{
 const now=Date.now();
 for(const timestamp_ms of [now+1,now-7*24*60*60*1000]) { const result=await run([record(0,'request',{timestamp_ms})],undefined,now); assert.notEqual(result.status,0); assert.equal(result.stdout,''); }
});
test('rejects file replaced at open boundary using fs hook',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'cache-monitor-'));
 try {
  const file=path.join(dir,'capture.jsonl'), replacement=path.join(dir,'replacement');
  await writeFile(file,JSON.stringify(record(0,'request'))+'\n');
  await writeFile(replacement,JSON.stringify(record(0,'response'))+'\n');
  const encoded=Buffer.from(`import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import {renameSync} from 'node:fs'; const original=fs.openSync; let swapped=false; fs.openSync=function(path,...args){ if(!swapped && String(path).endsWith('capture.jsonl')) { swapped=true; renameSync(${JSON.stringify(replacement)},${JSON.stringify(file)}); } return original.call(this,path,...args); }; syncBuiltinESMExports();`,'utf8').toString('base64');
  const result=spawnSync(process.execPath,['--import',`data:text/javascript;base64,${encoded}`,analyzer,dir],{encoding:'utf8'});
  assert.notEqual(result.status,0); assert.equal(result.stdout,''); assert.match(result.stderr,/Invalid cache monitor capture/);
 } finally { await rm(dir,{recursive:true,force:true}); }
});
test('rejects FIFO and path-swapped inputs without stdout or blocking',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'cache-monitor-'));
 try {
  execFileSync('mkfifo',[path.join(dir,'fifo')]); let result=spawnSync(process.execPath,[analyzer,dir],{encoding:'utf8',timeout:2000}); assert.notEqual(result.status,0); assert.equal(result.stdout,'');
 } finally { await rm(dir,{recursive:true,force:true}); }
 const swapped=await mkdtemp(path.join(os.tmpdir(),'cache-monitor-'));
 try { const file=path.join(swapped,'capture.jsonl'), other=path.join(swapped,'other'); await writeFile(file,JSON.stringify(record(0,'request'))+'\\n'); await writeFile(other,JSON.stringify(record(0,'response'))+'\\n'); await rename(file,other); await rename(other,file);
  const result=spawnSync(process.execPath,[analyzer,swapped],{encoding:'utf8'}); assert.notEqual(result.status,0); assert.equal(result.stdout,'');
 } finally { await rm(swapped,{recursive:true,force:true}); }
});
test('rejects symlink inputs without stdout',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'cache-monitor-'));
 try { const target=path.join(dir,'target'); await writeFile(target,JSON.stringify(record(0,'request'))+'\\n'); await symlink(target,path.join(dir,'capture'));
  const result=spawnSync(process.execPath,[analyzer,dir],{encoding:'utf8'}); assert.notEqual(result.status,0); assert.equal(result.stdout,'');
 } finally { await rm(dir,{recursive:true,force:true}); }
});
test('suppresses comparisons on null hashes, conflicting metadata, duplicate indices, and sequence gaps',async()=>{
 const cases=[];
 let a=record(0,'request'), b=record(0,'response'), c=record(1,'request'), d=record(1,'response'); a.model_id_hash=null; cases.push([a,b,c,d]);
 a=record(0,'request'); b=record(0,'response',{provider:'anthropic'}); c=record(1,'request'); d=record(1,'response'); cases.push([a,b,c,d]);
 a=record(0,'request'); b=record(0,'response'); c=record(1,'request'); d=record(1,'response'); c.invocation_index=0; d.invocation_index=0; cases.push([a,b,c,d]);
 a=record(0,'request'); b=record(0,'response'); c=record(1,'request'); d=record(1,'response'); c.sequence=9; cases.push([a,b,c,d]);
 for(const rows of cases) { const result=await run(rows); assert.equal(JSON.parse(result.stdout).labels.observed_client_payload_delta,0); assert.equal(JSON.parse(result.stdout).labels.unchanged_observed_payload_low_cache_upstream_or_unobserved,0); }
});
test('interleaved streams and restarted epochs do not create cross-group sequence gaps',async()=>{
 const otherStream='00000000-0000-4000-8000-000000000099';
 const rows=[];
 for(const [idx,type] of [[0,'request'],[0,'response'],[1,'request'],[1,'response']]) {
  rows.push(record(idx,type));
  rows.push({...record(idx,type),local_stream_id:otherStream,sequence:idx*2+(type==='response'?1:0)});
 }
 const restarted=rows.slice(0,4).map(r=>({...r,local_epoch_id:'00000000-0000-4000-8000-000000000088'}));
 const result=await run([...rows,...restarted]);
 assert.equal(JSON.parse(result.stdout).labels.unchanged_observed_payload_low_cache_upstream_or_unobserved,2);
});
test('conflicting duplicate key suppresses its invocation comparison',async()=>{
 const duplicate=record(0,'request'); const conflict={...duplicate,incomplete:true};
 const result=await run([duplicate,conflict,record(0,'response'),record(1,'request'),record(1,'response')]);
 assert.equal(JSON.parse(result.stdout).labels.unchanged_observed_payload_low_cache_upstream_or_unobserved,0);
});
test('incomplete response and unknown reset or retry states block comparisons',async()=>{
 for(const marker of [
  record(1,'response',{incomplete:true}),
  record(1,'unknown',{association:'context_reset'}),
  record(1,'unknown',{association:'retry_ambiguous'}),
  record(1,'unknown',{association:'incomplete_fingerprint'}),
 ]) {
  const rows=[record(0,'request'),record(0,'response'),record(1,'request'),record(1,'response'),marker];
  const result=await run(rows);
  assert.equal(JSON.parse(result.stdout).labels.unchanged_observed_payload_low_cache_upstream_or_unobserved,0);
 }
});
test('missing response prevents request from entering comparison',async()=>{
 const laterRequest=record(1,'request'); laterRequest.sequence=1;
 const laterResponse=record(1,'response'); laterResponse.sequence=2;
 const result=await run([record(0,'request'),laterRequest,laterResponse]);
 const labels=JSON.parse(result.stdout).labels;
 assert.equal(labels.unmatched_response,1);
 assert.equal(labels.unchanged_observed_payload_low_cache_upstream_or_unobserved,0);
});
test('interleaved groups retain their independent positive comparisons',async()=>{
 const otherStream='00000000-0000-4000-8000-000000000099'; const rows=[];
 for(const idx of [0,1]) for(const type of ['request','response']) {
  rows.push(record(idx,type)); rows.push({...record(idx,type),local_stream_id:otherStream,sequence:idx*2+(type==='response'?1:0)});
 }
 const result=await run(rows);
 assert.equal(JSON.parse(result.stdout).labels.unchanged_observed_payload_low_cache_upstream_or_unobserved,2);
});
test('null hashes report insufficient evidence without fabricated telemetry gap',async()=>{
 const result=await run([record(0,'request',{model_id_hash:null}),record(0,'response',{model_id_hash:null}),record(1,'request',{model_id_hash:null}),record(1,'response',{model_id_hash:null})]);
 const labels=JSON.parse(result.stdout).labels;
 assert.equal(labels.insufficient_evidence,2); assert.equal(labels.telemetry_gap,0);
});
test('incomplete response suppresses comparison',async()=>{
 const rows=[record(0,'request'),record(0,'response'),record(1,'request'),record(1,'response',{incomplete:true})];
 assert.equal(JSON.parse((await run(rows)).stdout).labels.unchanged_observed_payload_low_cache_upstream_or_unobserved,0);
});
test('sentinel reset and telemetry gap suppress epoch comparisons',async()=>{
 for(const association of ['context_reset','telemetry_gap']) {
  const sentinel={...record(9,'unknown'),local_epoch_id:epoch,local_invocation_id:'00000000-0000-0000-0000-000000000000',local_stream_id:'00000000-0000-0000-0000-000000000000',association,sequence:4};
  const labels=JSON.parse((await run([record(0,'request'),record(0,'response'),record(1,'request'),record(1,'response'),sentinel])).stdout).labels;
  assert.equal(labels.unchanged_observed_payload_low_cache_upstream_or_unobserved,0);
 }
});
test('duplicate index on unmatched invocation suppresses otherwise adjacent comparison',async()=>{
 const unmatched=record(1,'request'); const matchedReq=record(1,'request'); matchedReq.local_invocation_id='00000000-0000-4000-8000-000000000010'; matchedReq.sequence=4;
 const matchedResp=record(1,'response'); matchedResp.local_invocation_id=matchedReq.local_invocation_id; matchedResp.sequence=5;
 const rows=[record(0,'request'),record(0,'response'),unmatched,matchedReq,matchedResp,record(2,'request'),record(2,'response')];
 assert.equal(JSON.parse((await run(rows)).stdout).labels.unchanged_observed_payload_low_cache_upstream_or_unobserved,0);
});
test('unknown-only invocation sharing index suppresses otherwise adjacent comparison',async()=>{
 const marker={...record(1,'unknown',{association:'unmatched'}),local_invocation_id:'00000000-0000-4000-8000-000000000010'};
 const rows=[record(0,'request'),record(0,'response'),record(1,'request'),record(1,'response'),marker,record(2,'request'),record(2,'response')];
 assert.equal(JSON.parse((await run(rows)).stdout).labels.unchanged_observed_payload_low_cache_upstream_or_unobserved,0);
});
test('sentinel gap and reset preserve both labels in either order',async()=>{
 const sentinel=(association,sequence)=>({...record(9,'unknown'),local_invocation_id:'00000000-0000-0000-0000-000000000000',local_stream_id:'00000000-0000-0000-0000-000000000000',association,sequence});
 for(const markers of [[sentinel('telemetry_gap',4),sentinel('context_reset',5)],[sentinel('context_reset',4),sentinel('telemetry_gap',5)]]) {
  const labels=JSON.parse((await run([...markers,record(0,'request'),record(0,'response'),record(1,'request'),record(1,'response')])).stdout).labels;
  assert.ok(labels.telemetry_gap>=1); assert.ok(labels.context_reset>=1);
 }
});
test('null usage cannot produce low-cache label',async()=>{
 const response=record(0,'response'); response.usage=null;
 const result=await run([record(0,'request'),response,record(1,'request'),record(1,'response')]);
 assert.equal(JSON.parse(result.stdout).labels.insufficient_evidence,1);
});
