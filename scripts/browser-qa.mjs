import {createRequire} from 'node:module'
import {createServer} from 'node:http'
import {readFile,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
const root=fileURLToPath(new URL('../',import.meta.url))
const require=createRequire(import.meta.url)
const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'playwright')
const csp="default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; frame-src 'none'; child-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
const server=createServer(async(req,res)=>{
 try{
  if(!['/','/before'].includes(req.url)){res.writeHead(404).end();return}
  const before=req.url==='/before'
  const path=name=>before?`${root}/.build/${{html:'index-before-account-ui.html',js:'app-before-account-ui.js',css:'style-before-account-ui.css'}[name]}`:`${root}/web/${{html:'index.html',js:'app.js',css:'app.css'}[name]}`
  const [html,js,css]=await Promise.all(['html','js','css'].map(ext=>readFile(path(ext),'utf8')))
  // Match CPS's classic, inlined resource delivery and restrictive page CSP.
  res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy',csp)
  res.end(html.replace('<link rel="stylesheet" href="app.css">',()=>'<style>'+css+'</style>').replace('<script defer src="app.js"></script>',()=>'<script>'+js+'</script>'))
 }catch{res.writeHead(500).end()}
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BINARY})
const page=await browser.newPage({viewport:{width:1440,height:1100}})
const errors=[],external=[]
page.on('pageerror',e=>errors.push(e.message))
page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:') && !r.url().startsWith('data:'))external.push(r.url())})
await page.addInitScript(()=>{
 const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 300"><rect width="500" height="300" fill="#d9f1ec"/><circle cx="420" cy="50" r="28" fill="#ffe196"/><path d="M0 235 Q140 100 290 230 T500 210 V300 H0Z" fill="#9ac5ab"/><g fill="none" stroke="#29585d" stroke-width="5"><circle cx="145" cy="230" r="45"/><circle cx="330" cy="230" r="45"/><path d="M145 230 L208 150 L245 230 L145 230 L305 165 L330 230 M245 230 L226 160"/></g><path d="M190 135 Q225 180 280 145 L290 90 Q285 50 260 75 L240 125Z" fill="white" stroke="#29585d" stroke-width="4"/><path d="M280 85 L360 96 L282 115Z" fill="#f6b64c" stroke="#29585d" stroke-width="3"/><circle cx="275" cy="80" r="4" fill="#29585d"/><text x="25" y="35" font-size="15">演示绘图 · 非真实模型结果</text><script>parent.hacked=true</script><image href="https://example.invalid/tracker"/><animate attributeName="opacity" values="1;.8;1" dur="2s" repeatCount="indefinite"/></svg>'
 const accounts=[
  {id:'account-us-east',name:'openai OAuth',email:'us-east@example.invalid',plan:'pro',enabled:true},
  {id:'account-us-west',name:'openai OAuth',email:'us-west@example.invalid',plan:'plus',enabled:true},
  {id:'account-no-email',name:'openai OAuth',email:null,plan:'pro',enabled:true},
  {id:'account-disabled',name:'美国备用',email:'disabled@example.invalid',plan:'pro',enabled:false},
  {id:'account-pending',name:'待继续账号',email:'pending@example.invalid',plan:'plus',enabled:true}
 ]
 const time=Date.UTC(2026,9,21,6,0,0)
 const make=(id,account_id,kind,extra={})=>({id,slot:Number(id.slice(1)),created_at:time-Number(id.slice(1))*60_000,account_id,account_name:'openai OAuth',kind,model:'test-model',effort:'low',variant:'original',status:'completed',jobs:[{}],attempts:[{status:'completed',correct:true,answer:'此账户的旧回答 '+account_id+'，答案是 21',duration_ms:100,usage:{input_tokens:14000,output_tokens:20},request_id:'fixture-'+id}],report:{correct:1,valid:1,total:1},...extra})
 const initial=[make('r0','account-us-east','candy'),make('r1','account-us-west','candy',{report:{correct:0,valid:1,total:1}}),make('r2','account-us-east','pelican',{report:{html:svg}}),make('r3','account-us-west','pelican',{report:{html:'<html><head><style>svg{background:#eff8ee}</style></head><body>'+svg+'</body></html>'}}),make('r4','account-disabled','candy'),make('r5','account-removed','candy',{account_name:'美国旧账号',account_email:'removed@example.invalid'}),make('r6','account-us-east','candy'),make('r7','account-us-east','pelican',{report:{html:'<svg><broken></svg>'}})]
 if(!localStorage.getItem('runs'))localStorage.setItem('runs',JSON.stringify(initial))
 window.fixture={calls:[],failRun:false,failBootstrap:false,holdStart:false,holdStep:false,failStep:false}
 window.codexProxyPlugin={version:2,request:async q=>{
  const data=q.body?JSON.parse(q.body):null,path=q.path.slice(4)
  window.fixture.calls.push({path,data})
  let runs=JSON.parse(localStorage.getItem('runs')),out,status=200
  if(path==='bootstrap'){
   if(window.fixture.failBootstrap)throw Error('模拟账号加载失败')
   out={accounts,keys:[{id:'k',name:'演示 Key'}]}
  }
  if(path==='models')out={models:['test-model']}
  if(path==='history')out={runs:location.pathname==='/before'?runs:runs.map(r=>{
   const summary=structuredClone(r);delete summary.jobs;summary.attempts.forEach(a=>delete a.answer);summary.has_drawing=!!summary.report?.html;if(summary.report)delete summary.report.html;return summary
  }),limit:64}
  if(path==='run'){
   if(window.fixture.failRun){window.fixture.failRun=false;throw Error('模拟原文加载失败')}
   out={run:runs.find(r=>r.id===data.id && r.slot===data.slot)}
  }
  if(path==='start'){
   if(window.fixture.holdStart)await new Promise(resolve=>{window.fixture.releaseStart=()=>{window.fixture.holdStart=false;resolve()}})
   const a=accounts.find(a=>a.id===data.account_id)
   if(!a?.enabled){status=400;out={error:{message:'账号不可测试'}}}
   else{const run={...data,id:crypto.randomUUID(),slot:runs.length,created_at:Date.now(),account_name:a.name,account_email:a.email,account_plan:a.plan,jobs:Array(data.kind==='fingerprint'?3:data.kind==='candy'?data.runs:1).fill({}),attempts:[],status:'ready'};runs.unshift(run);out={run}}
  }
  if(path==='step'){
   if(window.fixture.holdStep)await new Promise(resolve=>{window.fixture.releaseStep=()=>{window.fixture.holdStep=false;resolve()}})
   await new Promise(resolve=>setTimeout(resolve,150))
   if(window.fixture.failStep){window.fixture.failStep=false;throw Error('模拟请求中断')}
   const run=runs.find(r=>r.id===data.id);run.attempts.push({status:'completed',answer:'答案是 21',correct:true,duration_ms:100,usage:{input_tokens:14000,output_tokens:20},request_id:'fixture-request'})
   run.status=run.attempts.length===run.jobs.length?'completed':'ready'
   if(run.status==='completed')run.report=run.kind==='candy'?{correct:run.attempts.length,valid:run.attempts.length,total:run.attempts.length}:run.kind==='fingerprint'?{attribution:{prediction_name:'参考模型',probability:.7}}:{html:svg}
   out={run}
  }
  if(path==='stop'){const run=runs.find(r=>r.id===data.id);run.status='stopped';out={run}}
  localStorage.setItem('runs',JSON.stringify(runs))
  return {status,contentType:'application/json',body:new TextEncoder().encode(JSON.stringify(out)).buffer}
 }}
})
const ready=()=>page.getByText('选择账号后开始测试',{exact:true}).waitFor()
const done=()=>page.getByText('测试已完成',{exact:true}).waitFor()
const account=id=>page.locator('article[data-account="'+id+'"]')
const shots=root+'/.build/screenshots'
try{
 await mkdir(shots,{recursive:true})
 if(process.env.CAPTURE_BEFORE){
  await page.goto(`http://127.0.0.1:${server.address().port}/before`)
  await page.getByText('选择账号后开始测试。',{exact:true}).waitFor()
  await page.locator('#kind').selectOption('pelican')
  await page.screenshot({path:shots+'/before-pelican.png',fullPage:true})
 }
 await page.goto(`http://127.0.0.1:${server.address().port}`);await ready()
 assert.equal(await account('account-us-east').locator('strong').textContent(),'us-east@example.invalid')
 assert.equal(await account('account-us-west').locator('strong').textContent(),'us-west@example.invalid')
 assert.match(await account('account-no-email').textContent(),/ID: account-no-email/)
 assert.equal(await account('account-disabled').locator('input').isDisabled(),true)
 assert.equal(await account('account-removed').locator('.test-account').isDisabled(),true)
 assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.path==='run').length),0,'Initial summary must not fetch full answers')
 await account('account-us-east').locator('.account-history > summary').click()
 await account('account-us-east').locator('.run > summary').first().click()
 await account('account-us-east').getByText('此账户的旧回答 account-us-east，答案是 21',{exact:true}).waitFor()
 assert.equal(await account('account-us-east').locator('.run').count(),2)
 assert.ok(!(await account('account-us-east').textContent()).includes('旧回答 account-us-west'))
 await page.screenshot({path:shots+'/accounts-history.png',fullPage:true})
 // Search includes names, email and IDs; the header checkbox selects only visible enabled accounts.
 await page.locator('#account-search').fill('us-');await page.locator('#all').check()
 assert.equal(await page.locator('.select-account:checked').count(),2)
 await page.locator('#account-search').fill('');assert.match(await page.locator('#selected-count').textContent(),/2/)
 await page.locator('#runs').fill('2');await page.evaluate(()=>{fixture.holdStep=true});await page.locator('#start').click()
 await page.waitForFunction(()=>typeof fixture.releaseStep==='function')
 assert.equal(await page.locator('#progress-spinner').isVisible(),true)
 assert.match(await page.locator('#progress').textContent(),/us-east.*第 1\/2 题/)
 assert.match(await page.locator('#progress-detail').textContent(),/账号 1\/2/)
 assert.equal(await page.locator('#start').getAttribute('aria-busy'),'true')
 assert.equal(await account('account-us-east').locator('.test-account').getAttribute('aria-busy'),'true')
 assert.equal(await account('account-us-west').locator('.test-account').getAttribute('aria-busy'),'false')
 assert.equal(await page.locator('#kind').isDisabled(),true)
 assert.equal(await page.locator('#account-search').isEnabled(),true)
 assert.equal(await account('account-us-east').locator('.run[open]').count(),1,'Running tests must leave expanded history readable')
 await page.waitForFunction(()=>document.getElementById('progress-detail').textContent.includes('已等待 1 秒'))
 assert.equal(await page.locator('#progress-spinner').evaluate(el=>getComputedStyle(el).animationName),'eval-spin')
 await page.screenshot({path:shots+'/evaluation-running.png'})
 await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'})
 assert.equal(await page.locator('#progress-spinner').evaluate(el=>getComputedStyle(el).animationName),'none')
 assert.equal(await account('account-us-east').locator('.account-activity').isVisible(),true)
 await page.screenshot({path:shots+'/evaluation-running-dark.png'})
 await page.setViewportSize({width:390,height:844})
 await page.locator('.account-panel').evaluate(el=>el.scrollIntoView({block:'start'}))
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await page.screenshot({path:shots+'/evaluation-running-mobile.png'})
 await page.setViewportSize({width:1440,height:1100});await page.emulateMedia({colorScheme:'light',reducedMotion:'no-preference'})
 await page.locator('#account-search').fill('us-east')
 assert.equal(await account('account-us-east').locator('.account-activity').isVisible(),true,'Account redraw must retain running state')
 await page.locator('#account-search').fill('')
 await page.evaluate(()=>fixture.releaseStep());await done()
 assert.equal(await page.locator('#progress-spinner').isHidden(),true)
 assert.equal(await page.locator('#start').getAttribute('aria-busy'),'false')
 assert.equal(await page.locator('.account.is-running').count(),0)
 assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.path==='step').length),4)
 assert.match(await account('account-us-east').locator('.recent').textContent(),/正确 2\/2/)
 await page.reload();await ready()
 assert.match(await account('account-us-east').locator('.recent').textContent(),/正确 2\/2/)
 // Single-account test does not depend on checkboxes; pause/resume preserves the same run.
 await page.locator('#runs').fill('2');await page.evaluate(()=>{fixture.holdStep=true;delete fixture.releaseStep})
 await account('account-us-east').locator('.test-account').click()
 await page.waitForFunction(()=>typeof fixture.releaseStep==='function')
 await page.locator('#pause').click()
 assert.match(await page.locator('#progress').textContent(),/本题完成后暂停/)
 assert.equal(await page.locator('#pause').isDisabled(),true)
 assert.equal(await page.locator('#progress-spinner').isVisible(),true,'Pause must wait for the in-flight request')
 await page.evaluate(()=>fixture.releaseStep())
 await page.getByText('已暂停，可在历史记录中继续',{exact:true}).waitFor()
 await account('account-us-east').locator('.account-history > summary').click()
 await account('account-us-east').locator('.run > summary').first().click()
 await account('account-us-east').getByRole('button',{name:'继续测试'}).click();await done()
 await page.locator('#kind').selectOption('fingerprint');await account('account-us-west').locator('.test-account').click();await done()
 assert.match(await account('account-us-west').locator('.recent').textContent(),/70.0%/)
 await page.locator('#kind').selectOption('pelican')
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('.account-row .thumbnail img')).filter(i=>i.complete && i.naturalWidth>0).length===2)
 await page.screenshot({path:shots+'/pelican-thumbnails.png',fullPage:true})
 const thumb=account('account-us-west').locator('.account-row > .thumbnail')
 await thumb.click();await page.locator('#preview[open]').waitFor()
 await page.waitForFunction(()=>document.getElementById('drawing').naturalWidth>0)
 assert.match(await page.locator('#preview-title').textContent(),/us-west/)
 assert.equal(await page.evaluate(()=>document.activeElement.id),'close-preview')
 await page.screenshot({path:shots+'/pelican-preview.png'})
 await page.keyboard.press('Escape');assert.equal(await page.locator('#preview').getAttribute('open'),null)
 assert.equal(await thumb.evaluate(el=>el===document.activeElement),true)
 await page.waitForFunction(()=>!document.getElementById('drawing').hasAttribute('src'))
 assert.equal(await page.evaluate(()=>window.hacked),undefined)
 assert.deepEqual(external,[])
 // Invalid drawings are isolated and remain readable as source.
 if(!await account('account-us-east').locator('.account-history').evaluate(el=>el.open))await account('account-us-east').locator('.account-history > summary').click()
 await account('account-us-east').getByText('无法预览，展开原文',{exact:true}).waitFor()
 await page.locator('#history-scope').selectOption('all')
 assert.match(await account('account-us-east').locator('.account-history > summary').textContent(),/全部测试/)
 assert.ok(await account('account-us-east').locator('.run').count()>=5)
 // A detail fetch failure is retryable and does not hide the account's history.
 await page.evaluate(()=>{fixture.failRun=true})
 await account('account-disabled').locator('.account-history > summary').click()
 await account('account-disabled').locator('.run > summary').click()
 await account('account-disabled').getByText('模拟原文加载失败',{exact:true}).waitFor()
 await account('account-disabled').getByRole('button',{name:'重新加载'}).click()
 await account('account-disabled').getByText('此账户的旧回答 account-disabled，答案是 21',{exact:true}).waitFor()
 await page.locator('#account-search').fill('不存在的账号')
 await page.getByText('没有匹配的账号或历史记录',{exact:true}).waitFor()
 await page.locator('#account-search').fill('')
 await page.evaluate(()=>{fixture.failBootstrap=true});await page.locator('#refresh').click()
 await page.getByText('加载失败，请重试',{exact:true}).waitFor()
 assert.ok(await page.locator('article.account').count()>0)
 await page.evaluate(()=>{fixture.failBootstrap=false});await page.locator('#refresh').click();await ready()
 await page.locator('#history-scope').selectOption('current')
 while(await page.locator('.account-history[open]').count())await page.locator('.account-history[open] > summary').first().click()
 await page.emulateMedia({colorScheme:'dark'})
 await page.screenshot({path:shots+'/dark.png',fullPage:true})
 await page.setViewportSize({width:390,height:844})
 await page.reload();await ready();await page.locator('#kind').selectOption('pelican')
 await page.waitForFunction(()=>document.querySelector('.account-row .thumbnail img')?.naturalWidth>0)
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await page.locator('.account-panel').evaluate(el=>el.scrollIntoView({block:'start'}))
 await page.screenshot({path:shots+'/mobile.png'})
 await account('account-us-east').locator('.account-row > .thumbnail').click();await page.locator('#preview[open]').waitFor()
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await page.screenshot({path:shots+'/mobile-preview.png'})
 await page.keyboard.press('Escape')
 await page.emulateMedia({reducedMotion:'reduce'})
 await account('account-us-east').locator('.account-row > .thumbnail').click();await page.locator('#preview[open]').waitFor()
 assert.equal(await page.locator('#drawing').evaluate(el=>decodeURIComponent(el.src).includes('<animate')),false)
 await page.keyboard.press('Escape')
 await page.locator('#kind').selectOption('candy')
 // Pausing during preparation still exposes the saved run without sending a model request.
 const beforePreparingSteps=await page.evaluate(()=>fixture.calls.filter(c=>c.path==='step').length)
 await page.evaluate(()=>{fixture.holdStart=true})
 await account('account-us-east').locator('.test-account').click()
 await page.waitForFunction(()=>typeof fixture.releaseStart==='function')
 await page.locator('#pause').click()
 assert.match(await page.locator('#progress').textContent(),/准备完成后暂停/)
 await page.evaluate(()=>fixture.releaseStart())
 await page.getByText('已暂停，可在历史记录中继续',{exact:true}).waitFor()
 assert.match(await account('account-us-east').locator('.recent').textContent(),/待继续/)
 assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.path==='step').length),beforePreparingSteps)
 assert.equal(await page.locator('#progress-spinner').isHidden(),true)
 await page.evaluate(()=>{fixture.failStep=true})
 await account('account-us-east').locator('.test-account').click()
 await page.getByText('执行已中止，请刷新历史核对请求状态',{exact:true}).waitFor()
 assert.equal(await page.locator('#progress-spinner').isHidden(),true)
 assert.equal(await page.locator('.account.is-running').count(),0)
 assert.equal(await page.locator('#start').isEnabled(),true)
 await page.evaluate(()=>{
  const saved=JSON.parse(localStorage.getItem('runs'));saved[0].status='running';localStorage.setItem('runs',JSON.stringify(saved))
 })
 await page.reload();await ready()
 assert.match(await account('account-us-east').locator('.recent').textContent(),/请求未确认 \/ 请核对日志/)
 assert.equal(await page.locator('#progress-spinner').isHidden(),true)
 assert.equal(await page.locator('.account.is-running').count(),0)
 assert.equal(await page.evaluate(()=>fixture.calls.filter(c=>c.path==='step').length),0,'Refresh must not retry an uncertain request')
 assert.deepEqual(errors,[])
 console.log('Browser QA passed: duplicate names, missing emails, search/selection, legacy/disabled/removed account histories, lazy retry, candy batch, pause/resume, fingerprint, SVG thumbnails/modal, strict CSP, keyboard, mobile, dark theme, running spinners, elapsed time, pause/error cleanup, restored running safety, reduced motion')
}finally{await browser.close();server.close()}
