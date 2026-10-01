const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(process.argv[2]||require('node:path').resolve(__dirname,'../menu-plan.html'),'utf8');
const html=source,code=html.slice(html.indexOf('// Confirmation display follows acknowledgement'),html.indexOf('// 확정본 전체를 엑셀로'));
function setup(){
 const saves=[],toasts=[],dialogs=[],errors=[];let diagnostic=0;
 const c={S:{start:'2026-10-05',plan:{},confirmed:{},_ts:{confirmed:{}}},window:{__skipBlankConfirm:true},document:{getElementById:()=>({click:()=>diagnostic++})},console,Date,Promise,
  addDays:(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*864e5).toISOString().slice(0,10),fmt:x=>x,stateEnsureShape:()=>{},nowStamp:()=>1,dirtyMark:()=>{},absorbPlan:()=>{},render:()=>{},mealOrderItems:x=>x,toast:x=>toasts.push(x),showSaveProblem:x=>errors.push(x),confirm:()=>dialogs.shift(),periodDates:()=>['2026-10-05',0,0,0,0,0,'2026-10-12'],saveWeekConfirmation:ws=>new Promise((resolve,reject)=>saves.push({ws,resolve,reject}))};
 vm.createContext(c);vm.runInContext(code,c);return {c,saves,toasts,dialogs,errors,diagnostic:()=>diagnostic,run:s=>vm.runInContext(s,c)};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
 let t=setup();assert.equal(t.c.confirmWeek('2026-10-05'),true);assert.equal(t.toasts.length,0);assert.match(t.c.weekConfirmationButton('2026-10-05',true),/disabled aria-busy="true"/);assert.doesNotMatch(t.c.weekConfirmationButton('2026-10-05',true),/done/);assert.equal(t.c.confirmWeek('2026-10-05'),false);assert.equal(t.saves.length,1);assert.ok(t.c.S.confirmed['2026-10-05']);t.saves[0].resolve({ok:true});await tick();assert.match(t.toasts[0],/확정했어요/);assert.match(t.c.weekConfirmationButton('2026-10-05',true),/done/);
 assert.equal(t.c.confirmWeek('2026-10-05'),false);assert.equal(t.saves.length,2);assert.equal(t.toasts.length,1);t.saves[1].resolve({ok:true});await tick();assert.match(t.toasts[1],/해제했어요/);
 t=setup();t.c.S.plan['2026-10-05']={점심:{items:[{n:'보존 메뉴'}]}};t.c.confirmWeek('2026-10-05');const snapshot=JSON.stringify(t.c.S);t.saves[0].reject(Error('offline'));await tick();assert.equal(JSON.stringify(t.c.S),snapshot);assert.equal(t.errors.length,0,'save core already reports promise rejection');assert.match(t.toasts[0],/공유 확인이 필요/);assert.doesNotMatch(t.toasts[0],/확정했어요/);assert.match(t.c.weekConfirmationButton('2026-10-05',true),/공유 확인 필요/);assert.equal(t.c.confirmWeek('2026-10-05'),false);assert.equal(t.saves.length,1);assert.equal(t.diagnostic(),1);
 t.c.resetWeekConfirmationUi('2026-10-12');assert.match(t.c.weekConfirmationButton('2026-10-05',true),/공유 확인 필요/);
 t=setup();t.c.confirmWeek('2026-10-05');t.saves[0].resolve({ok:false,unchanged:true});await tick();assert.match(t.toasts[0],/공유 확인이 필요/);
 t=setup();t.dialogs.push(false);t.c.confirmCurrent();assert.deepEqual(t.saves.map(x=>x.ws),['2026-10-05','2026-10-12']);t.saves[1].resolve({ok:true});t.saves[0].reject(Error('conflict'));await tick();assert.equal(t.toasts.filter(x=>/확정했어요/.test(x)).length,1);assert.match(t.toasts.find(x=>/확정했어요/.test(x)),/2026-10-12/);assert.match(t.c.weekConfirmationButton('2026-10-05',true),/공유 확인 필요/);
 t=setup();t.c.window.__skipBlankConfirm=false;t.dialogs.push(false,false);t.c.confirmCurrent();assert.equal(t.saves.length,0,'first-week cancel preserves two-week short circuit');
 t=setup();t.c.saveWeekConfirmation=()=>{throw Error('prepare failed')};assert.equal(t.c.confirmWeek('2026-10-05'),true);assert.equal(t.errors.length,1);assert.match(t.toasts[0],/공유 확인이 필요/);
 console.log('PASS: deferred confirm/cancel acknowledgement, double click, rejection/input preservation, non-ok result, exact-week reset, two-week success/failure and cancellation, synchronous throw');
})().catch(e=>{console.error(e);process.exitCode=1});
