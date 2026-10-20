const $ = id => document.getElementById(id)
let busy = false, paused = false, accounts = [], modelVersion = 0
const kindNames = {candy:'糖果题',fingerprint:'模型指纹',pelican:'画鹈鹕'}
const statusNames = {ready:'待继续',running:'请求中 / 中断待核对',completed:'已完成',stopped:'已停止'}
async function api(path, data) {
  const bridge = window.codexProxyPlugin
  if (!bridge || bridge.version !== 2) throw Error('请从 CPS 插件菜单打开此页')
  const response = await bridge.request({path:`api/${path}`,method:data === undefined?'GET':'POST',...(data === undefined?{}:{contentType:'application/json',body:JSON.stringify(data)})})
  if (!response.contentType.toLowerCase().startsWith('application/json')) throw Error('插件响应类型错误')
  const body = JSON.parse(new TextDecoder().decode(response.body))
  if (response.status < 200 || response.status >= 300) throw Error(body.error?.message || `请求失败 (${response.status})`)
  return body
}
function node(tag,text,className) {const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el}
function error(e) {$('error').textContent=e.message || String(e)}
function locked(value) {
  busy=value
  document.querySelectorAll('#config input,#config select,#accounts input,#all,#refresh').forEach(el=>el.disabled=value)
  $('start').disabled=value;$('pause').disabled=!value
}
function options(el,items,empty) {el.replaceChildren(new Option(empty,''),...items.map(item=>new Option(item.name || item.id,item.id)))}
async function models() {
  const sequence=++modelVersion,key=$('key').value
  options($('model'),[],'加载模型…');$('start').disabled=true
  try {if(!key) {options($('model'),[],'先选择 Client Key');return}
    const body=await api('models',{key_id:key});if(sequence!==modelVersion)return
    options($('model'),body.models.map(id=>({id})),'请选择模型')
    if(body.models.length)$('model').value=body.models.includes('gpt-6.1-sol')?'gpt-6.1-sol':body.models[0]
  } catch(e){error(e)}finally{if(sequence===modelVersion)$('start').disabled=busy || !$('model').value}
}
function selection() {return Array.from(document.querySelectorAll('#accounts input:checked')).map(el=>el.value)}
function drawAccounts() {
  $('accounts').replaceChildren(...accounts.map(a=>{const row=node('label',undefined,'account'),box=node('input');box.type='checkbox';box.value=a.id;const text=node('span',a.name || a.email || a.id);text.append(node('small',a.plan || '订阅未知'));row.append(box,text);return row}))
  $('count').textContent=`${accounts.length} 个`;$('all').checked=false
}
function result(run) {
  const r=run.report
  if(!r)return statusNames[run.status] || run.status
  if(r.error)return `无法评分：${r.error}`
  if(run.kind==='candy')return `正确 ${r.correct}/${r.valid} · 请求失败 ${r.total-r.valid}`
  if(run.kind==='pelican')return r.html?'绘图已生成 · 请人工查看':'未生成绘图'
  const a=r.attribution
  if(a?.decision==='not_model')return '数字序列不符合参考库特征'
  if(!a?.prediction_name)return '有效样本不足'
  return `${a.prediction_name} · ${a.probability==null?'样本不足，未计算概率':`${(a.probability*100).toFixed(1)}% 参考库归因概率`}`
}
function button(text,handler) {const b=node('button',text,'secondary');b.type='button';b.onclick=()=>Promise.resolve().then(handler).catch(error);return b}
function preview(html) {
  // SVG image mode disables scripts, DOM access and external resources, and fits CPS frame-src 'none'.
  const lower=html.toLowerCase(),start=lower.search(/<svg(?:\s|>)/),end=lower.lastIndexOf('</svg>')
  if(start<0 || end<start)throw Error('回答中没有可预览的 SVG，请查看回答原文')
  const doc=new DOMParser().parseFromString(html.slice(start,end+6),'image/svg+xml')
  if(doc.querySelector('parsererror'))throw Error('SVG 格式错误，请查看回答原文')
  const svg=doc.documentElement
  if(!svg.getAttribute('xmlns'))svg.setAttribute('xmlns','http://www.w3.org/2000/svg')
  const styles=Array.from(html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi),m=>m[1]).join('\n')
  if(styles){const style=doc.createElementNS('http://www.w3.org/2000/svg','style');style.textContent=styles;svg.prepend(style)}
  $('drawing').src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new XMLSerializer().serializeToString(svg))
  $('preview').showModal()
}
async function history() {
 const body=await api('history')
 $('history').replaceChildren(...body.runs.map(run=>{
  const el=node('details'),summary=node('summary');summary.append(node('div',`${kindNames[run.kind]} · ${run.account_name}`),node('div',result(run),'result'),node('div',`${run.model} · ${run.effort} · ${new Date(run.created_at).toLocaleString()} · ${statusNames[run.status]}`,'meta'));el.append(summary)
  const actions=node('div',undefined,'actions')
  if(run.status==='ready')actions.append(button('继续测试',async()=>{if(busy)throw Error('已有测试在执行');await perform(async()=>{await drive(run)})}))
  if(run.status==='ready'||run.status==='running')actions.append(button('停止此轮',async()=>{if(busy)throw Error('请先等待本题完成');await api('stop',{id:run.id,slot:run.slot});await history()}))
  if(run.report?.html)actions.append(button('查看绘图',()=>preview(run.report.html)))
  el.append(actions)
  if(run.report?.attribution)el.append(node('pre',JSON.stringify(run.report.attribution,null,2)))
  run.attempts.forEach((attempt,index)=>{const block=node('div',undefined,'sample');const tokens=attempt.usage?` · 输入 ${attempt.usage.input_tokens ?? '—'} / 输出 ${attempt.usage.output_tokens ?? '—'} Token`:'';block.append(node('div',`第 ${index+1} 题 · ${attempt.status==='failed'?'请求失败':run.kind==='candy'?(attempt.correct?'正确':'答错'):'完成'} · ${(attempt.duration_ms/1000).toFixed(1)} 秒${tokens}`));if(attempt.request_id)block.append(node('div',`请求 ID：${attempt.request_id}`,'meta'));block.append(node('pre',attempt.error || attempt.answer));el.append(block)})
  return el
 }))
 if(!body.runs.length)$('history').append(node('p','暂无测试记录。','muted'))
}
async function drive(run) {
 while(run.status==='ready' && !paused){$('progress').textContent=`${run.account_name} · ${kindNames[run.kind]} · 第 ${run.attempts.length+1}/${run.jobs.length} 题`;run=(await api('step',{id:run.id,slot:run.slot})).run;await history()}
 return run
}
async function perform(work) {
 if(busy)return;paused=false;$('error').textContent='';locked(true)
 try{await work();$('progress').textContent=paused?'已暂停。可在历史记录中继续。':'测试已完成。'}catch(e){error(e);$('progress').textContent='执行已中止。请刷新历史，核对请求状态后继续。';try{await history()}catch{}}finally{locked(false);$('start').disabled=!$('model').value}
}
$('config').onsubmit=e=>{e.preventDefault();const ids=selection();if(!ids.length){error(Error('请至少选择一个账号'));return}const query={kind:$('kind').value,key_id:$('key').value,model:$('model').value,effort:$('effort').value,variant:$('variant').value,runs:Number($('runs').value)};perform(async()=>{for(const account_id of ids){if(paused)break;const {run}=await api('start',{...query,account_id});await drive(run)}})}
$('pause').onclick=()=>{paused=true;$('pause').disabled=true;$('progress').textContent='当前请求结束后暂停…'}
$('all').onchange=()=>document.querySelectorAll('#accounts input').forEach(el=>el.checked=$('all').checked)
$('key').onchange=models
$('model').onchange=()=>{$('start').disabled=busy || !$('model').value}
$('kind').onchange=()=>{const kind=$('kind').value;$('runs-label').hidden=kind!=='candy';$('variant-label').hidden=kind!=='pelican';$('effort-label').hidden=kind==='fingerprint';$('hint').textContent=kind==='fingerprint'?'每轮随机抽取 3 道数字挑战；使用模型默认推理强度，概率仅比较内置参考库候选。':kind==='pelican'?'生成 HTML / SVG，预览时禁用脚本和外部资源。绘图质量由人工判断。':'糖果题按回答中是否出现独立数字 21 评分；展开原文核对结论。'}
$('close-preview').onclick=()=>{$('preview').close();$('drawing').removeAttribute('src')}
async function refresh(){if(busy)return;$('error').textContent='';try{const key=$('key').value;const data=await api('bootstrap');accounts=data.accounts;drawAccounts();options($('key'),data.keys,'请选择 Client Key');if(data.keys.some(k=>k.id===key))$('key').value=key;else if(data.keys.length)$('key').value=data.keys[0].id;await models();await history();$('progress').textContent='选择账号后开始测试。'}catch(e){error(e);$('progress').textContent='加载失败。'}}
$('refresh').onclick=refresh
refresh()
