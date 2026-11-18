#!/usr/bin/env node
import { opendir, lstat } from 'node:fs/promises';
import { openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import path from 'node:path';

const LIMITS = { files: 16, file: 1024 * 1024, total: 4 * 1024 * 1024, line: 16 * 1024, report: 2 * 1024 * 1024, retention: 7 * 24 * 60 * 60 * 1000 };
const LABELS = ['observed_client_payload_delta', 'unchanged_observed_payload_low_cache_upstream_or_unobserved', 'insufficient_evidence', 'telemetry_gap', 'context_reset', 'unmatched_response', 'retry_ambiguous', 'incomplete_fingerprint', 'uncorrelated_payload_only'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const TOP = ['schema_version','local_epoch_id','local_invocation_id','local_stream_id','sequence','invocation_index','timestamp_ms','provider','model_id_hash','config_id_hash','event_type','association','fingerprints','usage','incomplete'];
const USAGE = ['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens'];
const MAX_COUNTER = 2147483647;
const RAW_LINE = Symbol('raw line');
const fail = () => { throw new Error('Invalid cache monitor capture'); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const nullableHash = value => value === null || (typeof value === 'string' && HASH.test(value));
const safeInt = value => Number.isSafeInteger(value) && value >= 0;
function validate(r) {
  if (!exact(r, TOP) || r.schema_version !== 1 || typeof r.local_epoch_id!=='string' || !UUID.test(r.local_epoch_id) || !safeInt(r.sequence) || !safeInt(r.invocation_index) || !safeInt(r.timestamp_ms)) fail();
  const zero='00000000-0000-0000-0000-000000000000';
  const sentinel=r.local_invocation_id===zero && r.local_stream_id===zero;
  if (typeof r.local_invocation_id!=='string' || typeof r.local_stream_id!=='string' || (sentinel ? r.event_type!=='unknown' : (!UUID.test(r.local_stream_id) || !UUID.test(r.local_invocation_id))) || (r.local_invocation_id===zero)!==(r.local_stream_id===zero)) fail();
  if (!['openai','anthropic','google','other'].includes(r.provider) || !nullableHash(r.model_id_hash) || !nullableHash(r.config_id_hash)) fail();
  if (!['request','response','unknown'].includes(r.event_type) || !['paired','unmatched','retry_ambiguous','telemetry_gap','context_reset','incomplete_fingerprint'].includes(r.association) || typeof r.incomplete !== 'boolean') fail();
  if (!exact(r.fingerprints, ['prompt'])) fail();
  const fp = r.fingerprints.prompt;
  if (fp !== null && (!exact(fp, ['hmac_sha256','bytes','complete']) || typeof fp.hmac_sha256 !== 'string' || !HASH.test(fp.hmac_sha256) || !Number.isInteger(fp.bytes) || fp.bytes < 0 || fp.bytes > 131072 || typeof fp.complete !== 'boolean')) fail();
  if (r.event_type !== 'request' && fp !== null) fail();
  if (r.usage !== null && (!exact(r.usage, USAGE) || USAGE.some(k => r.usage[k] !== null && (!Number.isInteger(r.usage[k]) || r.usage[k] < 0 || r.usage[k] > MAX_COUNTER)))) fail();
  if (r.event_type !== 'response' && r.usage !== null) fail();
  if (r.event_type === 'unknown' && r.association === 'paired') fail();
  return r;
}
const tuple = r => `${r.local_epoch_id}/${r.local_invocation_id}/${r.local_stream_id}`;
const recordKey = r => `${tuple(r)}/${r.event_type}/${r.sequence}`;
function classify(inputs) {
  const counts = Object.fromEntries(LABELS.map(label => [label, 0]));
  const tuples = new Map();
  const sorted = [...inputs].sort((a,b) => a.sequence-b.sequence || recordKey(a).localeCompare(recordKey(b)));
  const records = new Map(), conflicted = new Set(), metadata = new Map(), epochSequences = new Map(), epochMarkers = new Map();
  const indexOwners=new Map();
  for (const r of sorted) {
    const key = recordKey(r), bytes = r[RAW_LINE], t=tuple(r);
    if (records.has(key)) { if (records.get(key) !== bytes) { conflicted.add(t); } continue; }
    records.set(key, bytes);
    if (!tuples.has(t)) tuples.set(t, []); tuples.get(t).push(r);
    const identity=[r.provider,r.model_id_hash,r.config_id_hash,r.invocation_index].join('/');
    if (metadata.has(t) && metadata.get(t)!==identity) conflicted.add(t); else metadata.set(t,identity);
    if (!epochSequences.has(r.local_epoch_id)) epochSequences.set(r.local_epoch_id,new Set()); epochSequences.get(r.local_epoch_id).add(r.sequence);
    if(r.local_invocation_id==='00000000-0000-0000-0000-000000000000' && ['context_reset','telemetry_gap'].includes(r.association)) { if(!epochMarkers.has(r.local_epoch_id)) epochMarkers.set(r.local_epoch_id,new Set()); epochMarkers.get(r.local_epoch_id).add(r.association); }
    const ik=`${r.local_epoch_id}/${r.local_stream_id}/${r.invocation_index}`; if(!indexOwners.has(ik)) indexOwners.set(ik,new Set()); indexOwners.get(ik).add(r.local_invocation_id);
  }
  const badEpochs=new Set();
  for(const [epoch,set] of epochSequences) { const seq=[...set].sort((a,b)=>a-b); for(let i=1;i<seq.length;i++) if(seq[i]!==seq[i-1]+1) { badEpochs.add(epoch); counts.telemetry_gap++; } }
  for(const markerSet of epochMarkers.values()) { if(markerSet.has('telemetry_gap')) counts.telemetry_gap++; if(markerSet.has('context_reset')) counts.context_reset++; }
  const invocations=[];
  for (const [t, rs] of tuples) {
    const req=rs.filter(r=>r.event_type==='request'), resp=rs.filter(r=>r.event_type==='response'), unknown=rs.filter(r=>r.event_type==='unknown');
    const duplicateConflict=rs.some(r=>r.association==='telemetry_gap');
    const base=rs[0]; let label=null;
    if (conflicted.has(t) || badEpochs.has(base.local_epoch_id) || duplicateConflict || rs.some(r=>r.association==='telemetry_gap')) { label='telemetry_gap'; }
    else if (epochMarkers.get(base.local_epoch_id)?.has('context_reset') || unknown.some(r=>r.association==='context_reset')) label='context_reset';
    else if (base.model_id_hash===null || base.config_id_hash===null) label='insufficient_evidence';
    else if (unknown.some(r=>r.association==='retry_ambiguous') || req.length>1 || resp.length>1) label='retry_ambiguous';
    else if (unknown.some(r=>r.association==='unmatched') || (req.length===1 && resp.length===0)) label='unmatched_response';
    else if (unknown.some(r=>r.association==='incomplete_fingerprint')) label='incomplete_fingerprint';
    else if (unknown.length) label='insufficient_evidence';
    if (!label && (req.length!==1 || resp.length!==1 || req[0].association!=='paired' || resp[0].association!=='paired')) label='insufficient_evidence';
    if (req.length===1 && resp.length===0 && !label) label='unmatched_response';
    if (label) counts[label]++;
    if (req.length===1 && resp.length===1) invocations.push({request:req[0],response:resp[0],group:[base.local_epoch_id,base.local_stream_id,base.provider,base.model_id_hash,base.config_id_hash].join('/'),label});
  }
  const eligible=invocations.filter(x=>x.label===null && !epochMarkers.has(x.request.local_epoch_id) && indexOwners.get(`${x.request.local_epoch_id}/${x.request.local_stream_id}/${x.request.invocation_index}`).size===1);
  const candidatesByGroup=new Map(); for(const x of eligible) { if(!candidatesByGroup.has(x.group)) candidatesByGroup.set(x.group,[]); candidatesByGroup.get(x.group).push(x); }
  for(const candidates of candidatesByGroup.values()) {
   candidates.sort((a,b)=>a.request.invocation_index-b.request.invocation_index || a.request.sequence-b.request.sequence);
   for(let i=1;i<candidates.length;i++) {
    const a=candidates[i-1], b=candidates[i];
    if(b.request.invocation_index!==a.request.invocation_index+1) continue;
    const fa=a.request.fingerprints.prompt, fb=b.request.fingerprints.prompt;
    let label;
    if (a.request.incomplete || b.request.incomplete || a.response.incomplete || b.response.incomplete || !fa || !fb || !fa.complete || !fb.complete) label='incomplete_fingerprint';
    else if(a.response.usage===null || b.response.usage===null) label='insufficient_evidence';
    else if(fa.hmac_sha256!==fb.hmac_sha256 || fa.bytes!==fb.bytes) label='observed_client_payload_delta';
    else if(b.response.usage.cache_read_tokens===0 && b.response.usage.input_tokens>0) label='unchanged_observed_payload_low_cache_upstream_or_unobserved';
    else label='insufficient_evidence';
    counts[label]++;
   }
  }
  return counts;
}
function boundedRead(file, expected, maxBytes) {
  const fd=openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened=fstatSync(fd); if(!opened.isFile() || opened.dev!==expected.dev || opened.ino!==expected.ino || opened.size>LIMITS.file) fail();
    const chunks=[]; let size=0, chunk=Buffer.alloc(8192);
    while(true) { const n=readSync(fd,chunk,0,chunk.length,null); if(!n) break; size+=n; if(size>LIMITS.file || size>maxBytes) fail(); chunks.push(Buffer.from(chunk.subarray(0,n))); }
    if(size!==opened.size) fail(); return Buffer.concat(chunks,size);
  } finally { closeSync(fd); }
}
async function analyze(dir) {
  const dst=await lstat(dir); if(!dst.isDirectory() || dst.isSymbolicLink()) fail();
  const directory=await opendir(dir); const names=[];
  for await (const entry of directory) { if(names.length===LIMITS.files) fail(); names.push(entry.name); }
  let total=0; const all=[]; let oldest=Infinity, newest=0;
  for(const name of names) {
    const p=path.join(dir,name), st=await lstat(p);
    if(!st.isFile() || st.isSymbolicLink() || st.size>LIMITS.file) fail();
    const remaining=LIMITS.total-total;
    if(st.size>LIMITS.file || st.size>remaining) fail();
    const data=boundedRead(p,st,remaining); const after=await lstat(p), dirAfter=await lstat(dir);
    if(after.dev!==st.dev || after.ino!==st.ino || after.isSymbolicLink() || dirAfter.dev!==dst.dev || dirAfter.ino!==dst.ino) fail();
    total+=data.length; if(total>LIMITS.total) fail();
    if(data.length===0) fail();
    const decoded=data.toString('utf8'); const lines=decoded.split('\n');
    if(lines.at(-1)==='') lines.pop();
    for(const line of lines) {
      if(!line || Buffer.byteLength(line)+(line===lines.at(-1) && !decoded.endsWith('\n') ? 0 : 1)>LIMITS.line) fail();
      let r; try { r=JSON.parse(line); } catch { fail(); }
      validate(r); Object.defineProperty(r,RAW_LINE,{value:line}); oldest=Math.min(oldest,r.timestamp_ms); newest=Math.max(newest,r.timestamp_ms); all.push(r);
    }
  }
  const now=Date.now(); if(oldest===Infinity || newest>now || now>=oldest+LIMITS.retention) fail();
  const report=JSON.stringify({groups: new Set(all.map(r=>[r.local_epoch_id,r.local_stream_id,r.provider,r.model_id_hash,r.config_id_hash].join('/'))).size,records:all.length,labels:classify(all)})+'\n';
  if(Buffer.byteLength(report)>LIMITS.report) fail(); return report;
}
if (process.argv.length!==3) { process.stderr.write('Usage: node scripts/analyze-cache-monitor.mjs <capture-dir>\n'); process.exitCode=2; }
else { try { process.stdout.write(await analyze(process.argv[2])); } catch { process.stderr.write('Invalid cache monitor capture\n'); process.exitCode=1; } }
