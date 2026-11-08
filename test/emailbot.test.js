const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const KEY = 'test-emailbot-integration-key-more-than-32-chars';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emailbot-flowmaster-'));
  fs.mkdirSync(path.join(root, 'flows'));
  fs.writeFileSync(path.join(root, 'flows', 'registry.json'), JSON.stringify([{
    id: 'inbox', name: 'Inbox fixture', script: 'fixture.js', supportsInspect: true,
    fields: [{ name: 'INBOX_USERNAME', label: 'Username', required: true, pattern: '^[a-zA-Z0-9._-]{1,64}$' },
             { name: 'INBOX_PASSWORD', label: 'Password', secret: true }]
  }]));
  // This fixture writes fake credentials only. No browser, network or real signup.
  fs.writeFileSync(path.join(root, 'flows', 'fixture.js'), `
    const fs=require('node:fs'),path=require('node:path');
    if(process.env.EMAILBOT_INTEGRATION_KEY)throw Error('Integration key leaked to child');
    const password=process.env.INBOX_PASSWORD||'generated-test-password';
    fs.writeFileSync(path.join(process.env.FLOW_OUTPUT_DIR,'inbox-credentials.json'),JSON.stringify({
      email:process.env.INBOX_USERNAME+'@inbox.eu',password,status:'registered'}));
    console.log('fixture completed');
  `);
  const app = createApp({ root, integrationKey: KEY, appOrigin: 'https://flowmaster.example' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { Host:'flowmaster.example', 'Content-Type':'application/json', 'X-Emailbot-Key':KEY, 'X-Emailbot-Owner':'2', 'X-Emailbot-Request':'test-request-0123456789' };
  const request = (url, method='GET', body, extra={}) => fetch(base+url,{method,headers:{...headers,...extra},body:body===undefined?undefined:JSON.stringify(body)});
  t.after(async()=>{app.stop();await new Promise(r=>setTimeout(r,150));fs.rmSync(root,{recursive:true,force:true});});
  const start = async()=>{
    const body={flowId:'inbox',inspect:false,variables:{INBOX_USERNAME:'fakeuser',INBOX_PASSWORD:'private-test-password'}};
    const response=await request('/api/runs','POST',body);assert.equal(response.status,202);
    const run=await response.json();
    for(let i=0;i<100;i++){
      const r=await request('/api/runs/'+run.id).then(r=>r.json());
      if(r.status!=='running')return r;
      await new Promise(r=>setTimeout(r,20));
    }
    throw Error('Fixture timeout');
  };
  return {root,app,request,start,headers};
}

test('confirmed result is service-authenticated, user-bound and no-store',async t=>{
  const {request,start}=await fixture(t);
  const capabilities=await request('/api/emailbot/capabilities');assert.equal(capabilities.status,200);
  const run=await start();assert.equal(run.status,'succeeded');
  assert.ok(!JSON.stringify(run).includes('private-test-password'));
  for(const extra of [{'X-Emailbot-Key':'wrong'},{'X-Emailbot-Key':''},{'X-Emailbot-Owner':'3'}]){
    const r=await request('/api/runs/'+run.id+'/result','GET',undefined,extra);
    assert.ok([403,404].includes(r.status));assert.ok(!(await r.text()).includes('private-test-password'));
  }
  const result=await request('/api/runs/'+run.id+'/result');assert.equal(result.status,200);
  assert.equal(result.headers.get('cache-control'),'no-store');
  const credentials=await result.json();assert.equal(credentials.status,'registered');
  assert.equal(credentials.email,'fakeuser@inbox.eu');assert.equal(credentials.password,'private-test-password');
  assert.equal((await request('/api/runs/'+run.id,'GET',undefined,{'X-Emailbot-Owner':'3'})).status,404);
  assert.equal((await request('/api/runs/'+run.id+'/cancel','POST',{}, {'X-Emailbot-Owner':'3'})).status,404);
  assert.deepEqual(await request('/api/runs','GET',undefined,{'X-Emailbot-Owner':'3'}).then(r=>r.json()),[]);
});

test('idempotency and recovery survive persisted runs',async t=>{
  const {request,start}=await fixture(t);const run=await start();
  const again=await request('/api/runs','POST',{flowId:'inbox',inspect:false,variables:{INBOX_USERNAME:'fakeuser'}});
  assert.equal(again.status,202);assert.equal((await again.json()).id,run.id);
  const recovered=await request('/api/emailbot/requests/test-request-0123456789').then(r=>r.json());
  assert.equal(recovered.id,run.id);
  assert.equal((await request('/api/emailbot/requests/test-request-0123456789','GET',undefined,{'X-Emailbot-Owner':'3'})).status,404);
});

test('inspect-only and nonregistered credential files cannot be handed off',async t=>{
  const {request,start,root,app}=await fixture(t);const run=await start();
  const file=path.join(root,'data','runs',run.id,'inbox-credentials.json');
  for(const data of [{status:'pending',email:'fakeuser@inbox.eu',password:'secret'},
                    {status:'registered',email:'other@inbox.eu',password:'secret'},null]){
    fs.writeFileSync(file,JSON.stringify(data));
    assert.equal((await request('/api/runs/'+run.id+'/result')).status,409);
  }
  fs.rmSync(file);assert.equal((await request('/api/runs/'+run.id+'/result')).status,409);
  const inspect=await request('/api/runs','POST',{flowId:'inbox',inspect:true,variables:{INBOX_USERNAME:'fakeuser'}}, {'X-Emailbot-Request':'inspect-request-0123456789'});
  assert.equal(inspect.status,400);
});

test('result routes fail closed when service key is unconfigured',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'flow-no-key-'));
  fs.mkdirSync(path.join(root,'flows'));fs.writeFileSync(path.join(root,'flows','registry.json'),'[]');
  const app=createApp({root,integrationKey:''});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  try{
    const base=`http://127.0.0.1:${app.server.address().port}`;
    assert.equal((await fetch(base+'/api/emailbot/capabilities')).status,403);
    assert.equal((await fetch(base+'/api/runs/abc/result')).status,403);
  }finally{app.stop();fs.rmSync(root,{recursive:true,force:true});}
});
