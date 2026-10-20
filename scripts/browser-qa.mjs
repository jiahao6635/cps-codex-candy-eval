import {createRequire} from 'node:module'
import {createServer} from 'node:http'
import {readFile,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
const root=fileURLToPath(new URL('../',import.meta.url))
const require=createRequire(import.meta.url)
const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'playwright')
const server=createServer(async(req,res)=>{try{const name=req.url==='/'?'index.html':req.url.slice(1);if(!['index.html','app.js','app.css'].includes(name)){res.writeHead(404).end();return}res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');let content=await readFile(`${root}/web/${name}`);if(name==='index.html'){content=content.toString().replace('<link rel="stylesheet" href="app.css">','<style>'+await readFile(`${root}/web/app.css`,'utf8')+'</style>').replace('<script defer src="app.js"></script>','<script>'+await readFile(`${root}/web/app.js`,'utf8')+'</script>');res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; frame-src 'none'; child-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'")}res.end(content)}catch{res.writeHead(500).end()}})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BINARY})
const page=await browser.newPage({viewport:{width:1360,height:1000}})
const errors=[];page.on('pageerror',e=>errors.push(e.message))
await page.addInitScript(()=>{
 window.codexProxyPlugin={version:2,request:async q=>{
  const data=q.body?JSON.parse(q.body):null,path=q.path.slice(4)
  let runs=JSON.parse(localStorage.getItem('runs') || '[]'),out
  if(path==='bootstrap')out={accounts:[{id:'a',name:'演示账号 A',plan:'pro'},{id:'b',name:'演示账号 B',plan:'plus'}],keys:[{id:'k',name:'测试 Key'}]}
  if(path==='models')out={models:['test-model']}
  if(path==='history')out={runs}
  if(path==='start'){const run={...data,id:crypto.randomUUID(),slot:runs.length,created_at:Date.now(),account_name:`演示账号 ${data.account_id.toUpperCase()}`,jobs:Array(data.kind==='fingerprint'?3:data.runs).fill({}),attempts:[],status:'ready'};runs.unshift(run);out={run}}
  if(path==='step'){await new Promise(resolve=>setTimeout(resolve,120));const run=runs.find(r=>r.id===data.id);run.attempts.push({status:'completed',answer:'答案是 21',correct:true,duration_ms:100,usage:{input_tokens:14000,output_tokens:20},request_id:'fixture-request'});run.status=run.attempts.length===run.jobs.length?'completed':'ready';if(run.status==='completed')run.report=run.kind==='candy'?{correct:run.attempts.length,valid:run.attempts.length,total:run.attempts.length}:run.kind==='fingerprint'?{attribution:{prediction_name:'参考模型',probability:.7}}:{html:'<svg xmlns="http://www.w3.org/2000/svg"><text y="30">绘图演示</text></svg><script>parent.hacked=true</script><img src="https://example.invalid/tracker">'};out={run}}
  if(path==='stop'){const run=runs.find(r=>r.id===data.id);run.status='stopped';out={run}}
  localStorage.setItem('runs',JSON.stringify(runs))
  return {status:200,contentType:'application/json',body:new TextEncoder().encode(JSON.stringify(out)).buffer}
 }}
})
try{
 await page.goto(`http://127.0.0.1:${server.address().port}`)
 await page.getByText('选择账号后开始测试。',{exact:true}).waitFor()
 await page.locator('#all').check()
 await page.locator('#runs').fill('2')
 await page.locator('#start').click()
 await page.getByText('测试已完成。',{exact:true}).waitFor()
 assert.equal(await page.locator('#history > details').count(),2)
 assert.match(await page.locator('#history').textContent(),/正确 2\/2/)
 await page.reload();await page.getByText('选择账号后开始测试。',{exact:true}).waitFor()
 assert.equal(await page.locator('#history > details').count(),2)
 await page.locator('#all').check();await page.locator('#kind').selectOption('fingerprint');await page.locator('#start').click();await page.getByText('测试已完成。',{exact:true}).waitFor()
 assert.match(await page.locator('#history').textContent(),/70.0%/)
 await page.locator('#kind').selectOption('pelican');await page.locator('#start').click();await page.getByText('测试已完成。',{exact:true}).waitFor()
 await page.locator('#history > details').first().locator('summary').click()
 await page.getByRole('button',{name:'查看绘图'}).first().click()
 assert.match(await page.locator('#drawing').getAttribute('src'),/^data:image\/svg\+xml/)
 assert.equal(await page.evaluate(()=>window.hacked),undefined)
 await page.getByRole('button',{name:'关闭',exact:true}).click()
 await mkdir(`${root}/.build/screenshots`,{recursive:true})
 await page.screenshot({path:`${root}/.build/screenshots/desktop.png`,fullPage:true})
 await page.setViewportSize({width:390,height:844})
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await page.screenshot({path:`${root}/.build/screenshots/mobile.png`,fullPage:true})
 await page.emulateMedia({colorScheme:'dark'});await page.screenshot({path:`${root}/.build/screenshots/dark.png`,fullPage:true})
 assert.deepEqual(errors,[])
 console.log('Browser QA passed: batch candy, fingerprint, drawing sandbox, refreshed history, responsive layouts, dark theme')
}finally{await browser.close();server.close()}
