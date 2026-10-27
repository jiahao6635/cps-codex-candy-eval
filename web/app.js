const $ = id => document.getElementById(id)
let busy = false, paused = false, accounts = [], runs = [], modelVersion = 0, activity = null, activityTimer = null
const selected = new Set(), expandedAccounts = new Set(), expandedRuns = new Set(), runCache = new Map()
const kindNames = {candy:'糖果题',fingerprint:'模型指纹',pelican:'画鹈鹕'}
const statusNames = {ready:'待继续',running:'请求未确认 / 请核对日志',completed:'已完成',stopped:'已停止'}
async function api(path, data) {
  const bridge = window.codexProxyPlugin
  if (!bridge || bridge.version !== 2) throw Error('请从 CPS 插件菜单打开此页')
  const response = await bridge.request({path:'api/'+path,method:data === undefined?'GET':'POST',...(data === undefined?{}:{contentType:'application/json',body:JSON.stringify(data)})})
  if (!response.contentType.toLowerCase().startsWith('application/json')) throw Error('插件响应类型错误')
  const body = JSON.parse(new TextDecoder().decode(response.body))
  if (response.status < 200 || response.status >= 300) throw Error(body.error?.message || '请求失败 ('+response.status+')')
  return body
}
function node(tag,text,className) {const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el}
function error(e) {$('error').textContent=e.message || String(e)}
function options(el,items,empty) {el.replaceChildren(new Option(empty,''),...items.map(item=>new Option(item.name || item.id,item.id)))}
function button(text,handler) {const b=node('button',text,'secondary');b.type='button';b.onclick=()=>Promise.resolve().then(handler).catch(error);return b}
function selectable(a) {return a.enabled === true && !a.removed}
function spinner() {const el=node('span',undefined,'spinner');el.setAttribute('aria-hidden','true');return el}
function paintActivity() {
  const waiting=activity ? Math.floor((performance.now()-activity.startedAt)/1000) : 0
  $('progress-spinner').hidden=!activity
  $('progress-panel').classList.toggle('is-active',!!activity)
  if(activity){
    const question=activity.question?' · 第 '+activity.question+'/'+activity.questions+' 题':''
    const pauseNote=activity.question?'本题完成后暂停':'准备完成后暂停'
    const message=activity.name+' · '+kindNames[activity.kind]+question+(paused?' · '+pauseNote:'')
    if($('progress').textContent!==message)$('progress').textContent=message
    $('progress-detail').textContent='账号 '+activity.accountIndex+'/'+activity.accountTotal+' · '+activity.phase+' · 已等待 '+waiting+' 秒'
  }else $('progress-detail').textContent=''
  for(const row of document.querySelectorAll('article.account')){
    const current=activity?.accountId===row.dataset.account
    row.classList.toggle('is-running',current)
    const status=row.querySelector('.account-activity')
    status.hidden=!current
    if(current){
      status.querySelector('.activity-label').textContent=activity.phase+(activity.question?' · 第 '+activity.question+'/'+activity.questions+' 题':'')
      status.querySelector('.elapsed').textContent='已等待 '+waiting+' 秒'+(paused?' · '+(activity.question?'本题完成后暂停':'准备完成后暂停'):'')
    }
    const test=row.querySelector('.test-account')
    if(test.getAttribute('aria-busy')!==String(current)){
      test.setAttribute('aria-busy',String(current))
      test.setAttribute('aria-label',(current?'正在测评 ':'测试 ')+row.querySelector('strong').textContent)
      test.replaceChildren(...(current?[spinner(),node('span','测评中')]:[node('span','测试')]))
    }
  }
}
function setActivity(value) {
  activity=value?{...value,startedAt:performance.now()}:null
  clearInterval(activityTimer)
  activityTimer=activity?setInterval(paintActivity,1000):null
  paintActivity()
}
function locked(value) {
  busy=value
  document.querySelectorAll('#config input,#config select,#refresh').forEach(el=>el.disabled=value)
  document.querySelectorAll('.select-account,.test-account').forEach(el=>el.disabled=value || !selectable(allAccounts().find(a=>a.id===el.dataset.account)))
  $('pause').disabled=!value
  $('pause').textContent='本题完成后暂停'
  $('start').setAttribute('aria-busy',String(value))
  $('start').replaceChildren(...(value?[spinner(),node('span','测评进行中')]:[node('span','测试选中的账号')]))
  syncSelection()
}
async function models() {
  const sequence=++modelVersion,key=$('key').value
  options($('model'),[],'加载模型…');$('start').disabled=true
  try {if(!key) {options($('model'),[],'先选择 Client Key');return}
    const body=await api('models',{key_id:key});if(sequence!==modelVersion)return
    options($('model'),body.models.map(id=>({id})),'请选择模型')
    if(body.models.length)$('model').value=body.models.includes('gpt-6.1-sol')?'gpt-6.1-sol':body.models[0]
  } catch(e){error(e)}finally{if(sequence===modelVersion)syncSelection()}
}
function accountTitle(a) {
  const name=(a.name || '').trim(),email=(a.email || '').trim()
  return (!name || /^openai(?:\s+(?:oauth|账号|account))?$/i.test(name)) ? email || name || a.id : name
}
function allAccounts() {
  const byId=new Map(accounts.map(a=>[a.id,{...a}]))
  for(const run of runs) {
    if(!byId.has(run.account_id))byId.set(run.account_id,{id:run.account_id,name:run.account_name,email:run.account_email,plan:run.account_plan,enabled:false,removed:true})
  }
  return Array.from(byId.values())
}
function runAccount(run) {
  return accounts.find(a=>a.id===run.account_id) || {id:run.account_id,name:run.account_name,email:run.account_email,plan:run.account_plan}
}
function visibleAccounts() {
  const search=$('account-search').value.trim().toLowerCase(),filter=$('account-filter').value,kind=$('kind').value
  const visible=allAccounts().filter(a=>{
    const latest=runs.find(r=>r.account_id===a.id && r.kind===kind)
    const match=!search || [a.id,a.name,a.email,...runs.filter(r=>r.account_id===a.id).flatMap(r=>[r.account_name,r.account_email])].some(value=>String(value || '').toLowerCase().includes(search))
    return match && (filter==='all' || filter==='enabled' && selectable(a) || filter==='untested' && !latest || filter==='wrong' && latest?.kind==='candy' && (latest.attempts || []).some(x=>x.status==='completed' && x.correct===false) || filter==='failed' && (latest?.attempts || []).some(x=>x.status==='failed'))
  })
  if($('account-sort').value==='recent')visible.sort((a,b)=>(runs.find(r=>r.account_id===b.id && r.kind===kind)?.created_at || 0)-(runs.find(r=>r.account_id===a.id && r.kind===kind)?.created_at || 0))
  if($('account-sort').value==='rate')visible.sort((a,b)=>rate(a.id).value-rate(b.id).value)
  return visible
}
function rate(id) {
  const attempts=runs.filter(r=>r.account_id===id && r.kind==='candy' && r.model===$('model').value && (r.effort || 'none')===$('effort').value).flatMap(r=>r.attempts || []).filter(a=>a.status==='completed' && typeof a.correct==='boolean')
  const correct=attempts.filter(a=>a.correct).length
  return {correct,total:attempts.length,value:attempts.length?correct/attempts.length:Infinity}
}
function markKind(a) {return a.status==='failed'?'failed':a.status==='completed' && a.correct===true?'correct':a.status==='completed' && a.correct===false?'wrong':'pending'}
const markLabels={correct:'答对',wrong:'答错',failed:'请求失败',pending:'待确认'}
async function showRecord(run,index) {
  const attempt=(await fullRun(run)).attempts?.[index]
  if(!attempt)throw Error('此记录不存在，请刷新列表')
  $('record-title').textContent=accountTitle(runAccount(run))+' · '+markLabels[markKind(attempt)]
  const content=$('record-content');content.replaceChildren(node('p',metadata(run),'meta'),node('p',usageText({...run,attempts:[attempt]}),'meta'),answerView(attempt.error || attempt.answer || '没有保存回答原文'))
  $('record-preview').showModal()
}
function recentMarks(accountRuns) {
  const wrap=node('div',undefined,'recent-marks')
  const records=accountRuns.filter(r=>r.kind==='candy').flatMap(r=>(r.attempts || []).map((a,i)=>({run:r,attempt:a,index:i})).reverse()).slice(0,20)
  for(const {run,attempt,index} of records){
    const kind=markKind(attempt),label=markLabels[kind],mark=button(kind==='correct'?'✓':kind==='wrong'?'×':kind==='failed'?'!':'–',()=>showRecord(run,index))
    mark.className='result-mark mark-'+kind+(run.model!==$('model').value || (run.effort || 'none')!==$('effort').value?' mark-other':'')
    mark.title=label+' · '+metadata(run)+' · '+(attempt.preview || attempt.error || '点击查看详情')
    mark.setAttribute('aria-label',mark.title);wrap.append(mark)
  }
  return wrap
}
function answerView(text) {
  const el=node('div',undefined,'answer-text')
  // Build text nodes only: model output cannot inject HTML, links, images or scripts.
  const pattern=/(\*\*[^*\n]+\*\*|`[^`\n]+`|\\\([^\n]*?\\\)|\\\[[\s\S]*?\\\])/g
  let last=0
  for(const match of text.matchAll(pattern)){
    el.append(document.createTextNode(text.slice(last,match.index)))
    const token=match[0],tag=token.startsWith('**')?'strong':token.startsWith('`')?'code':'span'
    const part=node(tag,undefined,tag==='span'?'math-text':undefined),body=token.slice(tag==='code'?1:2,tag==='code'?-1:-2)
    if(tag==='span' && window.temml){try{window.temml.render(body,part,{trust:false,throwOnError:true,displayMode:token.startsWith('\\[')})}catch{part.textContent=body}}
    else part.textContent=body
    el.append(part)
    last=match.index+token.length
  }
  el.append(document.createTextNode(text.slice(last)))
  return el
}
function syncSelection() {
  const available=visibleAccounts().filter(selectable),checked=available.filter(a=>selected.has(a.id)).length
  $('all').checked=available.length>0 && checked===available.length
  $('all').indeterminate=checked>0 && checked<available.length
  $('all').disabled=busy || available.length===0
  $('selected-count').textContent='已选 '+selected.size+' 个'
  $('start').disabled=busy || !$('model').value
  document.querySelectorAll('.test-account').forEach(el=>el.disabled=busy || !$('model').value || !selectable(allAccounts().find(a=>a.id===el.dataset.account)))
}
function result(run) {
  const r=run.report
  if(!r)return statusNames[run.status] || run.status
  if(r.error)return '无法评分：'+r.error
  if(run.kind==='candy')return '正确 '+r.correct+'/'+r.valid+' · 请求失败 '+(r.total-r.valid)
  if(run.kind==='pelican')return run.has_drawing || r.html?'绘图已生成':'未生成绘图'
  const a=r.attribution
  if(a?.decision==='not_model')return '数字序列不符合参考库特征'
  if(!a?.prediction_name)return '有效样本不足'
  return a.prediction_name+' · '+(a.probability==null?'样本不足，未计算概率':(a.probability*100).toFixed(1)+'% 参考库归因概率')
}
function statusBadge(label,tone) {return node('span',label,'status-badge status-'+tone)}
function resultNode(run,classes='result') {
  const el=node('div',undefined,classes),r=run.report
  if(run.kind==='candy' && r && !r.error && run.status==='completed'){
    const allCorrect=r.total>0 && r.valid===r.total && r.correct===r.total
    const label=allCorrect?'✓ 答对':r.correct>0?'◐ 部分答对':r.valid>0?'✕ 答错':'! 请求失败'
    el.append(statusBadge(label,allCorrect?'success':r.correct>0?'warning':'danger'))
  }
  el.append(node('span',result(run)))
  return el
}
function attemptBadge(attempt,kind) {
  if(attempt.status==='failed')return statusBadge('! 请求失败','danger')
  if(attempt.status!=='completed')return statusBadge('待确认','neutral')
  if(kind!=='candy')return statusBadge('✓ 已完成','neutral')
  if(attempt.correct===true)return statusBadge('✓ 答对','success')
  if(attempt.correct===false)return statusBadge('✕ 答错','danger')
  return statusBadge('未评分','neutral')
}
function metadata(run) {
  const effort=run.kind==='fingerprint' || run.effort==='none'?'默认':run.effort
  return [kindNames[run.kind],run.model,effort,run.kind==='pelican'?(run.variant==='all-in-one'?'多合一':'原版'):null,new Date(run.created_at).toLocaleString(),statusNames[run.status]].filter(Boolean).join(' · ')
}
function usageText(run) {
  const attempts=run.attempts || [],sum=key=>attempts.reduce((n,a)=>n+(a.usage?.[key] || 0),0)
  return (attempts.reduce((n,a)=>n+(a.duration_ms || 0),0)/1000).toFixed(1)+' 秒 · 输入 '+sum('input_tokens').toLocaleString()+' / 输出 '+sum('output_tokens').toLocaleString()+' Token'
}
async function fullRun(run) {
  if(runCache.has(run.id))return runCache.get(run.id)
  const pending=api('run',{id:run.id,slot:run.slot}).then(body=>body.run)
  runCache.set(run.id,pending)
  try{return await pending}catch(e){if(runCache.get(run.id)===pending)runCache.delete(run.id);throw e}
}
function drawingSource(html,still=false) {
  // SVG image mode disables scripts, DOM access and external resources under the CPS CSP.
  const lower=html.toLowerCase(),start=lower.search(/<svg(?:\s|>)/),end=lower.lastIndexOf('</svg>')
  if(start<0 || end<start)throw Error('回答中没有可预览的 SVG，请展开回答原文')
  const doc=new DOMParser().parseFromString(html.slice(start,end+6),'image/svg+xml')
  if(doc.querySelector('parsererror'))throw Error('SVG 格式错误，请展开回答原文')
  const svg=doc.documentElement
  if(!svg.getAttribute('xmlns'))svg.setAttribute('xmlns','http://www.w3.org/2000/svg')
  const styles=Array.from(html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi),m=>m[1]).join('\n')
  if(styles){const style=doc.createElementNS('http://www.w3.org/2000/svg','style');style.textContent=styles;svg.prepend(style)}
  if(still){
    svg.querySelectorAll('animate,animateTransform,animateMotion,set').forEach(el=>el.remove())
    const style=doc.createElementNS('http://www.w3.org/2000/svg','style');style.textContent='*{animation-play-state:paused!important}';svg.append(style)
  }
  return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new XMLSerializer().serializeToString(svg))
}
async function preview(run) {
  const full=await fullRun(run)
  $('drawing').src=drawingSource(full.report?.html || '',matchMedia('(prefers-reduced-motion: reduce)').matches)
  $('preview-title').textContent=accountTitle(runAccount(full))+' · 鹈鹕画面'
  $('preview-meta').textContent=metadata(full)+' · '+usageText(full)
  $('preview-error').textContent=''
  $('preview').showModal()
}
const thumbnails=new IntersectionObserver(entries=>entries.forEach(entry=>{
  if(entry.isIntersecting){thumbnails.unobserve(entry.target);entry.target.loadDrawing()}
}),{rootMargin:'150px'})
function thumbnail(run) {
  const b=button('加载画面…',()=>preview(run));b.className='thumbnail';b.setAttribute('aria-label','放大查看 '+accountTitle(runAccount(run))+' 的鹈鹕画面')
  b.loadDrawing=async()=>{
    try{
      const full=await fullRun(run),img=node('img');img.alt='鹈鹕绘图缩略图';img.src=drawingSource(full.report?.html || '',true)
      img.onerror=()=>{b.textContent='画面无法显示，请展开原文'}
      b.replaceChildren(img,node('span','放大查看'))
    }catch(e){b.textContent='无法预览，展开原文';b.title=e.message}
  }
  thumbnails.observe(b)
  return b
}
function runDetails(run) {
  const el=node('details',undefined,'run'),summary=node('summary'),body=node('div',undefined,'run-body')
  el.dataset.run=run.id;el.open=expandedRuns.has(run.id)
  summary.append(resultNode(run),node('div',metadata(run),'meta'),node('div',usageText(run),'meta'))
  const snippet=(run.attempts || []).find(a=>a.preview || a.error)
  if(snippet){const excerpt=answerView(snippet.error || snippet.preview);excerpt.className='answer-snippet';summary.append(excerpt)}
  el.append(summary,body)
  const load=async()=>{
    body.replaceChildren(node('p','正在加载原文…','muted'))
    try{
      const full=await fullRun(run)
      if(!el.isConnected)return
      body.replaceChildren()
      const actions=node('div',undefined,'actions')
      if(full.status==='ready')actions.append(button('继续测试',async()=>{if(busy)throw Error('已有测试在执行');await perform(()=>drive(full))}))
      if(full.status==='ready'||full.status==='running')actions.append(button('停止此轮',async()=>{if(busy)throw Error('请先等待本题完成');await api('stop',{id:full.id,slot:full.slot});runCache.delete(full.id);await history()}))
      body.append(actions)
      if(full.report?.attribution)body.append(node('pre',JSON.stringify(full.report.attribution,null,2)))
      for(const [index,attempt] of full.attempts.entries()){
        const block=node('div',undefined,'sample')
        const heading=node('div',undefined,'sample-heading');heading.append(node('span','第 '+(index+1)+' 题'),attemptBadge(attempt,full.kind),node('span',(attempt.duration_ms/1000).toFixed(1)+' 秒'));block.append(heading)
        if(attempt.request_id)block.append(node('div','请求 ID：'+attempt.request_id,'meta'))
        if(attempt.storage_note)block.append(node('p',attempt.storage_note,'muted'))
        block.append(answerView(attempt.error || attempt.answer || '没有保存回答原文'));body.append(block)
      }
    }catch(e){body.replaceChildren(node('p',e.message,'error-text'),button('重新加载',load))}
  }
  el.ontoggle=()=>{if(el.open){expandedRuns.add(run.id);load()}else expandedRuns.delete(run.id)}
  const card=node('div',undefined,'history-card');card.append(el)
  if(run.has_drawing)card.append(thumbnail(run))
  return card
}
function drawAccounts() {
  thumbnails.disconnect()
  const visible=visibleAccounts(),kind=$('kind').value,allKinds=$('history-scope').value==='all'
  $('account-columns').hidden=kind!=='candy'
  $('accounts').replaceChildren(...visible.map(a=>{
    const accountRuns=runs.filter(r=>r.account_id===a.id),shown=accountRuns.filter(r=>allKinds || r.kind===kind),latest=accountRuns.find(r=>r.kind===kind)
    const article=node('article',undefined,'account');article.dataset.account=a.id
    const row=node('div',undefined,'account-row'),identity=node('label',undefined,'account-identity'),box=node('input'),info=node('span',undefined,'identity-text')
    box.type='checkbox';box.className='select-account';box.dataset.account=a.id;box.value=a.id;box.checked=selected.has(a.id);box.disabled=busy || !selectable(a);box.setAttribute('aria-label','选择 '+accountTitle(a)+' '+a.id)
    box.onchange=()=>{box.checked?selected.add(a.id):selected.delete(a.id);syncSelection()}
    info.append(node('strong',accountTitle(a)))
    const other=[a.name,a.email].filter(v=>v && v!==accountTitle(a))
    if(other.length)info.append(node('small',other.join(' · ')))
    info.append(node('small','ID: '+a.id,'account-id'))
    const badges=node('span',undefined,'badges');badges.append(node('span',a.plan || '订阅未知','tag'))
    if(!selectable(a))badges.append(node('span',a.removed?'已移除 · 仅历史':'已停用 · 仅历史','tag'))
    info.append(badges);identity.append(box,info);row.append(identity)
    const recent=node('div',undefined,'recent')
    const current=node('div',undefined,'account-activity'),state=node('div',undefined,'activity-state')
    current.hidden=true;state.append(spinner(),node('span',undefined,'activity-label'));current.append(state,node('div',undefined,'meta elapsed'));recent.append(current)
    recent.append(latest?resultNode(latest,'result recent-result'):node('div','暂无'+kindNames[kind]+'结果','result recent-result'))
    if(latest)recent.append(node('div',metadata(latest),'meta'),node('div',usageText(latest),'meta'))
    row.append(recent)
    if(kind==='candy'){
      const stats=rate(a.id),statsEl=node('div',undefined,'account-stats')
      statsEl.append(node('div',stats.total?Math.round(stats.value*100)+'% · '+stats.correct+'/'+stats.total:'暂无评分','rate-value'),node('div','当前模型 / 推理强度','meta'),recentMarks(accountRuns))
      row.append(statsEl)
    }
    if(latest?.has_drawing)row.append(thumbnail(latest))
    const test=button('测试',()=>startAccounts([a.id]));test.classList.add('test-account');test.dataset.account=a.id;test.setAttribute('aria-label','测试 '+accountTitle(a));row.append(test);article.append(row)
    const details=node('details',undefined,'account-history'),summary=node('summary'),records=node('div',undefined,'history-grid')
    details.open=expandedAccounts.has(a.id)
    summary.textContent='历史记录 · '+(allKinds?'全部测试':kindNames[kind])+' · '+shown.length+' 轮'+(!allKinds && accountRuns.length>shown.length?'（全部 '+accountRuns.length+' 轮）':'')
    const fill=()=>{if(!records.childElementCount){records.append(...shown.map(runDetails));if(!shown.length)records.append(node('p','该范围内没有保留的历史记录，可切换为全部测试','muted'))}}
    details.append(summary,records);details.ontoggle=()=>{if(details.open){expandedAccounts.add(a.id);fill()}else expandedAccounts.delete(a.id)}
    article.append(details)
    return article
  }))
  if(!visible.length)$('accounts').append(node('p','没有匹配的账号或历史记录','muted'))
  $('count').textContent=visible.length+' / '+allAccounts().length+' 个'
  $('history-count').textContent='已保存 '+runs.length+' 轮 · 每账号每类型保留最近 20 轮；合计最多 1200 轮、16 MiB。达到轮数上限时覆盖较早的已结束记录，达到空间上限时停止写入。'
  syncSelection();paintActivity()
}
async function history() {
  let cursor=0,all=[]
  do {const body=await api('history',{cursor});all.push(...body.runs);cursor=body.next} while(cursor!=null)
  runs=all.sort((a,b)=>b.created_at-a.created_at)
  const retained=new Set(runs.filter(r=>['completed','stopped'].includes(r.status)).map(r=>r.id))
  for(const id of runCache.keys())if(!retained.has(id))runCache.delete(id)
  drawAccounts()
}
async function drive(run,accountIndex=1,accountTotal=1) {
  while(run.status==='ready' && !paused){
    setActivity({accountId:run.account_id,name:accountTitle(runAccount(run)),kind:run.kind,question:run.attempts.length+1,questions:run.jobs.length,accountIndex,accountTotal,phase:'等待模型返回'})
    run=(await api('step',{id:run.id,slot:run.slot})).run
    activity.phase='正在刷新结果';paintActivity()
    runCache.delete(run.id);await history()
  }
  return run
}
async function perform(work) {
  if(busy)return;paused=false;$('error').textContent='';locked(true)
  try{await work();$('progress').textContent=paused?'已暂停，可在历史记录中继续':'测试已完成'}catch(e){
    error(e);setActivity(null);$('progress').textContent='执行已中止，请刷新历史核对请求状态';try{await history()}catch{}
  }finally{setActivity(null);locked(false)}
}
async function startAccounts(ids) {
  if(busy)throw Error('已有测试在执行')
  if(!ids.length)throw Error('请至少选择一个账号')
  if(!$('key').value || !$('model').value)throw Error('请选择 Client Key 和模型')
  const query={kind:$('kind').value,key_id:$('key').value,model:$('model').value,effort:$('effort').value,variant:$('variant').value,runs:Number($('runs').value)}
  await perform(async()=>{
    for(const [index,account_id] of ids.entries()){
      if(paused)break
      const a=accounts.find(a=>a.id===account_id)
      setActivity({accountId:account_id,name:accountTitle(a),kind:query.kind,accountIndex:index+1,accountTotal:ids.length,phase:'正在准备测试'})
      const {run}=await api('start',{...query,account_id})
      if(paused)await history()
      else await drive(run,index+1,ids.length)
    }
  })
}
$('config').onsubmit=e=>{e.preventDefault();startAccounts([...selected]).catch(error)}
$('pause').onclick=()=>{paused=true;$('pause').disabled=true;$('pause').textContent=activity?.question?'正在等待本题结束…':'正在等待准备完成…';paintActivity()}
$('all').onchange=()=>{for(const a of visibleAccounts().filter(selectable))$('all').checked?selected.add(a.id):selected.delete(a.id);drawAccounts()}
$('key').onchange=models
$('model').onchange=()=>{syncSelection();drawAccounts()}
$('account-search').oninput=drawAccounts
$('history-scope').onchange=drawAccounts
$('account-filter').onchange=drawAccounts
$('account-sort').onchange=drawAccounts
$('effort').onchange=drawAccounts
$('close-record').onclick=()=>$('record-preview').close()
$('kind').onchange=()=>{
  const kind=$('kind').value;$('runs-label').hidden=kind!=='candy';$('variant-label').hidden=kind!=='pelican';$('effort-label').hidden=kind==='fingerprint'
  $('hint').textContent=kind==='fingerprint'?'随机抽取 3 道数字挑战，概率仅比较内置参考库候选':kind==='pelican'?'点击缩略图放大查看，绘图质量由人工判断':'糖果题按回答中是否出现独立数字 21 评分，展开原文核对结论'
  drawAccounts()
}
$('close-preview').onclick=()=>$('preview').close()
$('preview').addEventListener('close',()=>$('drawing').removeAttribute('src'))
$('drawing').onerror=()=>{$('preview-error').textContent='画面无法显示，请关闭预览并展开回答原文'}
async function refresh(){
  if(busy)return;$('error').textContent='';$('refresh').disabled=true;$('progress').textContent='正在加载账号与历史…'
  try{
    const key=$('key').value,data=await api('bootstrap');accounts=data.accounts
    for(const id of selected)if(!accounts.some(a=>a.id===id && selectable(a)))selected.delete(id)
    options($('key'),data.keys,'请选择 Client Key');if(data.keys.some(k=>k.id===key))$('key').value=key;else if(data.keys.length)$('key').value=data.keys[0].id
    runCache.clear();await Promise.all([models(),history()]);$('progress').textContent='选择账号后开始测试'
  }catch(e){error(e);$('progress').textContent='加载失败，请重试'}finally{$('refresh').disabled=false}
}
$('refresh').onclick=refresh
refresh()
