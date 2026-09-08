const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const sample = {stats:{uniqueOwned:2},cardEntries:[
  {kind:'item',id:1,variants:[{foil:true},{},{foil:true}]},
  {kind:'npc',id:1,variants:[{}]},
]};
const group = {group: sample};
const catalog = {items:[{id:1,name:'Test item',wiki:{page:'Test item'},tcg:{variants:[{name:'Variant'}]}}],npcs:[{id:1,name:'Test NPC',wiki:{page:'Test NPC'}}]};
let data = {};
let requests = [];
let replies = [];
const listener = {addListener(){}};
const context = vm.createContext({console, setTimeout, chrome:{
  runtime:{onInstalled:listener,onStartup:listener,onMessage:listener},
  alarms:{onAlarm:listener,clear:async()=>{},create(){}},
  storage:{local:{
    get:async keys => Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,data[k]])),
    set:async values=>Object.assign(data,values),
    remove:async keys=>keys.forEach(k=>delete data[k]),
  }},
  tabs:{query:async()=>[]},
}, fetch:async(url,opts)=>{
  requests.push({url,...opts});
  const reply=replies.shift();
  assert.ok(reply, `Unexpected request: ${url}`);
  return {status:reply.status||200,ok:!reply.status||reply.status===200,statusText:'Failure',
    json:async()=>reply.body,headers:{get:()=>reply.etag||null}};
}});
vm.runInContext(fs.readFileSync(path.join(root,'background.js'),'utf8'),context);
const run = code=>vm.runInContext(code,context);
const render = vm.createContext({chrome:{runtime:{onMessage:listener,sendMessage:async()=>({})}},
  MutationObserver:class{observe(){}},document:{documentElement:{}},window:{}});
vm.runInContext(fs.readFileSync(path.join(root,'content.js'),'utf8'),render);
function verifyParsing(album, cards) {
  render.album=album; render.catalog=cards;
  vm.runInContext(`
    globalThis.entries = getOwnedEntries(album);
    globalThis.owned = new Map(entries.map(e=>[e.key,e]));
    globalThis.index = buildStatusIndex(catalog,owned);
    globalThis.copies = entries.reduce((n,e)=>n+countCopies(e),0);
    globalThis.foils = entries.reduce((n,e)=>n+countFoils(e),0);
    for (const matches of index.values()) summarizeEntries(matches,owned);
  `,render);
  assert.equal(render.entries.length,album.cardEntries.length);
  assert.equal(render.owned.size,album.cardEntries.length);
  assert.equal(render.copies,album.cardEntries.reduce((n,e)=>n+Math.max(1,e.variants.length),0));
  assert.equal(render.foils,album.cardEntries.reduce((n,e)=>n+e.variants.filter(v=>v.foil===true).length,0));
  return {entries:render.entries.length,copies:render.copies,foils:render.foils};
}
(async()=>{
  assert.equal(run('normalizeSettings({}).collectionMode'),'individual');
  await context.saveSettings({album:'Pack Main/#',collectionMode:'group'});
  replies=[{body:group,etag:'group-1'},{body:catalog}];
  let state=await context.refreshCollection();
  assert.equal(requests[0].url,'https://osrs-tcg.net/api/v1/players/Pack%20Main%2F%23/group');
  assert.equal(state.album.cardEntries.length,2);
  assert.equal(state.stats.uniqueOwned,2);
  verifyParsing(state.album,catalog);
  assert.equal(render.copies,4); assert.equal(render.foils,2);
  assert.equal(vm.runInContext("summarizeEntries(index.get('variant'),owned,'variant').variantOf",render),'Test item');
  assert.equal((await context.getSnapshot()).album.cardEntries.length,2);
  replies=[{status:304}];
  state=await context.refreshCollection();
  assert.equal(requests.at(-1).headers['If-None-Match'],'group-1');
  assert.equal(state.album.cardEntries.length,2);
  // A member-only change is loaded without consulting the individual stats endpoint.
  replies=[{body:{group:{...sample,cardEntries:[]}}}];
  state=await context.refreshCollection();
  assert.equal(state.album.cardEntries.length,0);
  assert.equal(data.albumEtag,null);
  assert.ok(requests.every(r=>!r.url.endsWith('/stats')));
  await context.saveSettings({album:'PackMain',collectionMode:'individual'});
  assert.equal(data.albumData,undefined); assert.equal(data.albumStats,undefined);
  replies=[{body:{revision:1}},{body:sample,etag:'individual-1'}];
  state=await context.refreshCollection();
  assert.equal(requests.at(-1).url,'https://api.osrs-tcg.net/api/v1/players/PackMain');
  assert.equal(Object.keys(requests.at(-1).headers).length,0);
  const before=requests.length;
  replies=[{body:{revision:1}}];
  await context.refreshCollection();
  assert.equal(requests.length,before+1);
  assert.ok(requests.at(-1).url.endsWith('/stats'));
  await context.saveSettings({album:'PackMain',collectionMode:'group'});
  replies=[{body:{group:null}}];
  await assert.rejects(context.refreshCollection(),/Group collection unavailable/);
  assert.equal(data.albumData,undefined);
  replies=[{status:404,body:{error:{message:'No group'}}}];
  await assert.rejects(context.refreshCollection(),/No group/);
  replies=[{status:304}];
  await assert.rejects(context.refreshCollection(),/304 without cached data/);
  // A settings change queued during a fetch must clear the old result afterward.
  let releaseFetch;
  const originalFetch=context.fetch;
  context.fetch=()=>new Promise(resolve=>{releaseFetch=()=>resolve({status:200,ok:true,json:async()=>group,headers:{get:()=>null}})});
  const pendingRefresh=context.refreshCollection();
  await new Promise(resolve=>setImmediate(resolve));
  const pendingSave=context.saveSettings({album:'AnotherPlayer',collectionMode:'individual'});
  releaseFetch();
  await Promise.all([pendingRefresh,pendingSave]);
  assert.equal(data.settings.album,'AnotherPlayer');
  assert.equal(data.albumData,undefined);
  context.fetch=originalFetch;
  // Popup selection persists and the normalized group stats populate its status.
  const elements=Object.fromEntries(['album','collectionMode','refreshMinutes','status','version','save','refresh'].map(id=>[id,{value:'',style:{},addEventListener(type,fn){this[type]=fn;}}]));
  const messages=[];
  const popup=vm.createContext({document:{querySelector:s=>elements[s.slice(1)]},chrome:{runtime:{getManifest:()=>({version:'0.1.1'}),sendMessage:async m=>{
    messages.push(m);
    if(m.type==='GET_SETTINGS')return {settings:{album:'PackMain',collectionMode:'group',refreshMinutes:15}};
    if(m.type==='SAVE_SETTINGS')return {settings:m.settings};
    return {settings:{collectionMode:'group'},album:sample};
  }}}});
  vm.runInContext(fs.readFileSync(path.join(root,'options.js'),'utf8'),popup);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(elements.collectionMode.value,'group');
  await elements.save.click();
  assert.equal(messages.find(m=>m.type==='SAVE_SETTINGS').settings.collectionMode,'group');
  assert.match(elements.status.textContent,/Group collection updated.*2 unique cards owned/);
  if(process.argv[2]){
    const fixtures=process.argv[2];
    const liveGroup=JSON.parse(fs.readFileSync(path.join(fixtures,'group-response.json')));
    const liveIndividual=JSON.parse(fs.readFileSync(path.join(fixtures,'individual-response.json')));
    const liveCatalog=JSON.parse(fs.readFileSync(path.join(fixtures,'catalog-response.json')));
    for(const [mode,payload] of [['group',liveGroup],['individual',liveIndividual]]){
      const album=context.normalizeCollection(payload,mode);
      const totals=verifyParsing(album,liveCatalog);
      assert.ok(totals.entries > 0);
      assert.ok(totals.foils > 0);
      // API summary stats can lag or differ from the actual card entries.
      // Verify parsing against the card payload itself, not those summaries.
      console.log(`Live ${mode}:`,totals);
    }
  }
  assert.equal(replies.length,0);
  console.log('Passed: mode persistence, URLs, normalization, cached snapshots, 304s, mode changes, member updates, errors, popup status, Wiki ownership/copies/foils/variants.');
})().catch(e=>{console.error(e);process.exitCode=1});

