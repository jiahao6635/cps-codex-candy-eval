const $ = id => document.getElementById(id)
let busy = false, paused = false, accounts = [], runs = [], modelVersion = 0
const selected = new Set(), expandedAccounts = new Set(), expandedRuns = new Set(), runCache = new Map()
const kindNames = {candy:'糖果题',fingerprint:'模型指纹',pelican:'画鹈鹕'}
const statusNames = {ready:'待继续',running:'请求中 / 中断待核对',completed:'已完成',stopped:'已停止'}
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
function locked(value) {
  busy=value
  document.querySelectorAll('#config input,#config select,#refresh').forEach(el=>el.disabled=value)
  document.querySelectorAll('.select-account,.test-account').forEach(el=>el.disabled=value || !selectable(allAccounts().find(a=>a.id===el.dataset.account)))
  $('pause').disabled=!value
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
  const search=$('account-search').value.trim().toLowerCase()
  return allAccounts().filter(a=>!search || [a.id,a.name,a.email,...runs.filter(r=>r.account_id===a.id).flatMap(r=>[r.account_name,r.account_email])].some(value=>String(value || '').toLowerCase().includes(search)))
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
  summary.append(node('div',result(run),'result'),node('div',metadata(run),'meta'),node('div',usageText(run),'meta'))
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
        block.append(node('div','第 '+(index+1)+' 题 · '+(attempt.status==='failed'?'请求失败':full.kind==='candy'?(attempt.correct?'正确':'答错'):'完成')+' · '+(attempt.duration_ms/1000).toFixed(1)+' 秒'))
        if(attempt.request_id)block.append(node('div','请求 ID：'+attempt.request_id,'meta'))
        if(attempt.storage_note)block.append(node('p',attempt.storage_note,'muted'))
        block.append(node('pre',attempt.error || attempt.answer || '没有保存回答原文'));body.append(block)
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
    recent.append(node('div',latest?result(latest):'暂无'+kindNames[kind]+'结果','result'))
    if(latest)recent.append(node('div',metadata(latest),'meta'),node('div',usageText(latest),'meta'))
    row.append(recent)
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
  $('history-count').textContent='已保存 '+runs.length+' 轮 · 所有账号合计最多保留 64 轮，较早的已结束记录会被覆盖'
  syncSelection()
}
async function history() {
  const body=await api('history');runs=body.runs.sort((a,b)=>b.created_at-a.created_at)
  const retained=new Set(runs.filter(r=>['completed','stopped'].includes(r.status)).map(r=>r.id))
  for(const id of runCache.keys())if(!retained.has(id))runCache.delete(id)
  drawAccounts()
}
async function drive(run) {
  while(run.status==='ready' && !paused){
    $('progress').textContent=accountTitle(runAccount(run))+' · '+kindNames[run.kind]+' · 第 '+(run.attempts.length+1)+'/'+run.jobs.length+' 题'
    run=(await api('step',{id:run.id,slot:run.slot})).run;runCache.delete(run.id);await history()
  }
  return run
}
async function perform(work) {
  if(busy)return;paused=false;$('error').textContent='';locked(true)
  try{await work();$('progress').textContent=paused?'已暂停，可在历史记录中继续':'测试已完成'}catch(e){error(e);$('progress').textContent='执行已中止，请刷新历史核对请求状态';try{await history()}catch{}}finally{locked(false)}
}
async function startAccounts(ids) {
  if(busy)throw Error('已有测试在执行')
  if(!ids.length)throw Error('请至少选择一个账号')
  if(!$('key').value || !$('model').value)throw Error('请选择 Client Key 和模型')
  const query={kind:$('kind').value,key_id:$('key').value,model:$('model').value,effort:$('effort').value,variant:$('variant').value,runs:Number($('runs').value)}
  await perform(async()=>{for(const account_id of ids){if(paused)break;const {run}=await api('start',{...query,account_id});await drive(run)}})
}
$('config').onsubmit=e=>{e.preventDefault();startAccounts([...selected]).catch(error)}
$('pause').onclick=()=>{paused=true;$('pause').disabled=true;$('progress').textContent='当前请求结束后暂停…'}
$('all').onchange=()=>{for(const a of visibleAccounts().filter(selectable))$('all').checked?selected.add(a.id):selected.delete(a.id);drawAccounts()}
$('key').onchange=models
$('model').onchange=syncSelection
$('account-search').oninput=drawAccounts
$('history-scope').onchange=drawAccounts
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
