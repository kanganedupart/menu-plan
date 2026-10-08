'use strict';
const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict');
const base=process.argv[2]||process.env.BASE_SHA;
assert(/^[a-f0-9]{40}$/.test(base||'')&&!/^0+$/.test(base),'An existing comparison commit is required');
const oldFile=name=>!cp.execFileSync('git',['ls-tree','--name-only',base,'--',name],{encoding:'utf8'}).trim()?'':cp.execFileSync('git',['show',base+':'+name],{encoding:'utf8',maxBuffer:16000000});
const files=['menu-plan.html','bareun-operation-journal.js','bareun-backup-archive.js','bareun-backup-runtime.js','menu-sync-diagnostics.js','bareun-shared-reconnect.js'];
const before=oldFile('menu-plan.html'),after=fs.readFileSync('menu-plan.html','utf8');
const pattern=/^const APP_BUILD='([^'\r\n]+)';/gm;
function build(source){const matches=[...source.matchAll(pattern)];assert.equal(matches.length,1,'Exactly one app build identifier is required');return matches[0][1]}
const oldBuild=build(before),newBuild=build(after);
const changed=files.some(name=>{const a=oldFile(name),b=fs.readFileSync(name,'utf8');return name==='menu-plan.html'?a.replace(pattern,'BUILD')!==b.replace(pattern,'BUILD'):a!==b});
if(changed)assert.notEqual(newBuild,oldBuild,'Runtime changed without changing APP_BUILD; existing clients cannot detect the release');
console.log(JSON.stringify({base,runtimeChanged:changed,oldBuild,newBuild,pass:true}));
