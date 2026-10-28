//! 管理路由、测试计划与逐题状态持久化

mod engine;
mod host;
use gateway_plugin_sdk::{
    ErrorCode, PluginFault,
    call::management::*,
    client::{AuthorError, ComposedPlugin, PluginBuilder, TypedCall, TypedReply},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::{Mutex, Semaphore};
// 为模型执行、评分和状态保存预留时间，保持小于管理页面桥的 180 秒期限
pub const MANAGEMENT_TIMEOUT_MS: u64 = 170_000;
const LEGACY_SLOTS: usize = 64;
const SLOTS: usize = 1200;
const GROUP_TARGET: usize = 20;
const MAX_PARALLEL: usize = 4;
pub(crate) fn fault(message: impl Into<String>) -> PluginFault {
    PluginFault::new(ErrorCode::InvalidInput, message)
}
pub(crate) fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
struct Service {
    engine: engine::Engine,
    lock: Mutex<()>,
    slots: Vec<Mutex<()>>,
    parallel: Semaphore,
}
pub fn plugin() -> Result<ComposedPlugin, Box<dyn std::error::Error>> {
    let engine = engine::Engine::bundled()?;
    Ok(build(Arc::new(Service {
        engine,
        lock: Mutex::new(()),
        slots: (0..SLOTS).map(|_| Mutex::new(())).collect(),
        parallel: Semaphore::new(MAX_PARALLEL),
    }))?)
}
fn build(service: Arc<Service>) -> Result<ComposedPlugin, AuthorError> {
    let registration = ManagementRegistration {
        routes: [
            ("GET", "api/bootstrap"),
            ("POST", "api/models"),
            ("GET", "api/history"),
            ("POST", "api/history"),
            ("POST", "api/run"),
            ("POST", "api/start"),
            ("POST", "api/step"),
            ("POST", "api/stop"),
        ]
        .into_iter()
        .map(|(method, path)| ManagementRoute {
            method: method.into(),
            path: path.into(),
            request_content_types: if method == "POST" {
                vec!["application/json".into()]
            } else {
                vec![]
            },
            response_content_types: vec!["application/json".into()],
        })
        .collect(),
        resources: [
            "web/index.html",
            "web/app.js",
            "web/app.css",
            "web/vendor/temml.min.js",
        ]
        .into_iter()
        .map(|path| ManagementResource {
            path: path.into(),
            public: false,
        })
        .collect(),
        pages: vec![ManagementPage {
            id: "candy-eval".into(),
            title: "Codex 能力测试".into(),
            description: Some("糖果题、模型指纹、画鹈鹕".into()),
            entry: "web/index.html".into(),
            icon: None,
        }],
        callbacks: vec![],
    };
    PluginBuilder::from_json(include_bytes!("../../plugin.json"))?.management(registration,move |call|{let s=service.clone();async move {
 let result=dispatch(&s,&call).await;
 let (status,body)=match result {Ok(v)=>(200,v),Err(e)=>(match e.code {ErrorCode::Conflict=>409,ErrorCode::PermissionDenied|ErrorCode::Rejected=>403,_=>400},json!({"error":{"message":e.message.chars().take(400).collect::<String>(),"code":e.code}}))};
 Ok(TypedReply::new(ManagementResponse{status,content_type:"application/json".into(),headers:vec![]}).with_payload(serde_json::to_vec(&body).map_err(|_|fault("响应编码失败"))?))
 }})?.build()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    account_id: String,
    key_id: String,
    model: String,
    kind: String,
    effort: String,
    variant: String,
    runs: usize,
}
impl Start {
    fn validate(&self) -> Result<(), PluginFault> {
        if !["candy", "fingerprint", "pelican"].contains(&self.kind.as_str())
            || !["none", "minimal", "low", "medium", "high", "xhigh"]
                .contains(&self.effort.as_str())
            || !["original", "all-in-one"].contains(&self.variant.as_str())
            || !(1..=10).contains(&self.runs)
            || self.model.is_empty()
            || self.model.len() > 200
            || self.model.chars().any(char::is_control)
            || self.account_id.is_empty()
            || self.key_id.is_empty()
        {
            return Err(fault("测试参数无效"));
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Key {
    key_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    id: String,
    slot: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryPage {
    cursor: usize,
}
fn input<T: serde::de::DeserializeOwned>(
    c: &TypedCall<ManagementRequest>,
) -> Result<T, PluginFault> {
    serde_json::from_slice(&c.payload).map_err(|_| fault("请求参数格式错误"))
}
async fn history_slots(
    h: &gateway_plugin_sdk::client::HostClient,
) -> Result<Vec<usize>, PluginFault> {
    let mut slots: Vec<usize> = (0..LEGACY_SLOTS).collect();
    if let Some((catalog, _)) = host::read_key(h, "catalog").await? {
        let extra = catalog["slots"]
            .as_array()
            .ok_or_else(|| fault("历史索引无效，已停止写入以保护记录"))?;
        for value in extra {
            let slot = value
                .as_u64()
                .and_then(|v| usize::try_from(v).ok())
                .filter(|v| (LEGACY_SLOTS..SLOTS).contains(v))
                .ok_or_else(|| fault("历史索引无效，已停止写入以保护记录"))?;
            if slots.contains(&slot) {
                return Err(fault("历史索引重复，已停止写入以保护记录"));
            }
            slots.push(slot);
        }
    }
    slots.sort_unstable();
    Ok(slots)
}
async fn read_histories(
    h: &gateway_plugin_sdk::client::HostClient,
    slots: &[usize],
) -> Result<Vec<(usize, Value, u64)>, PluginFault> {
    let mut rows = vec![];
    for &slot in slots {
        if let Some((r, v)) = host::read(h, slot).await? {
            rows.push((slot, r, v))
        }
    }
    rows.sort_by_key(|(_, r, _)| std::cmp::Reverse(r["created_at"].as_u64().unwrap_or(0)));
    Ok(rows)
}
async fn histories(
    h: &gateway_plugin_sdk::client::HostClient,
) -> Result<Vec<(usize, Value, u64)>, PluginFault> {
    read_histories(h, &history_slots(h).await?).await
}
fn history_summary(mut run: Value) -> Value {
    // 列表不携带题目、身份校验字段和回答正文，绘图及原文按轮次读取
    let fields = run.as_object_mut().unwrap();
    for key in ["jobs", "identity", "credential_revision"] {
        fields.remove(key);
    }
    if let Some(attempts) = run["attempts"].as_array_mut() {
        for attempt in attempts {
            if let Some(fields) = attempt.as_object_mut() {
                if let Some(answer) = fields.get("answer").and_then(Value::as_str) {
                    fields.insert(
                        "preview".into(),
                        json!(answer.chars().take(160).collect::<String>()),
                    );
                }
                fields.remove("answer");
            }
        }
    }
    run["has_drawing"] = json!(
        run["report"]["html"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
    );
    if let Some(report) = run["report"].as_object_mut() {
        report.remove("html");
    }
    run
}
async fn dispatch(s: &Service, c: &TypedCall<ManagementRequest>) -> Result<Value, PluginFault> {
    if !c.request.query.is_empty() || c.payload.len() > 8192 {
        return Err(fault("请求超限或包含未支持的查询参数"));
    }
    let h = &c.host;
    match (c.request.method.as_str(), c.request.path.as_str()) {
        ("GET", "api/bootstrap") => {
            Ok(json!({"accounts":host::list(h,true).await?,"keys":host::list(h,false).await?}))
        }
        ("POST", "api/models") => host::models(h, &input::<Key>(c)?.key_id).await,
        ("GET", "api/history") => Ok(
            json!({"runs":histories(h).await?.into_iter().map(|(_,r,_)|history_summary(r)).collect::<Vec<_>>(),"limit":SLOTS}),
        ),
        ("POST", "api/history") => {
            let q: HistoryPage = input(c)?;
            let slots = history_slots(h).await?;
            if q.cursor > slots.len() {
                return Err(fault("历史分页位置无效"));
            }
            let end = (q.cursor + 24).min(slots.len());
            let rows = read_histories(h, &slots[q.cursor..end]).await?;
            Ok(
                json!({"runs":rows.into_iter().map(|(_,r,_)|history_summary(r)).collect::<Vec<_>>(),"next":if end < slots.len() {Some(end)} else {None},"limit":SLOTS}),
            )
        }
        ("POST", "api/run") => {
            let q: Identity = input(c)?;
            if q.slot >= SLOTS {
                return Err(fault("历史槽位无效"));
            }
            let (mut run, _) = host::read(h, q.slot)
                .await?
                .ok_or_else(|| fault("历史记录不存在"))?;
            if run["id"] != q.id {
                return Err(fault("此历史记录已被覆盖，请刷新列表"));
            }
            let fields = run.as_object_mut().unwrap();
            for key in ["identity", "credential_revision"] {
                fields.remove(key);
            }
            Ok(json!({"run":run}))
        }
        ("POST", "api/start") => {
            let q: Start = input(c)?;
            q.validate()?;
            let account = host::list(h, true)
                .await?
                .into_iter()
                .find(|v| v["id"] == q.account_id && v["enabled"] == true)
                .ok_or_else(|| fault("请选择已启用的 OpenAI 账号"))?;
            if !host::list(h, false)
                .await?
                .iter()
                .any(|v| v["id"] == q.key_id)
            {
                return Err(fault("请选择已启用的 Client Key"));
            }
            if !host::models(h, &q.key_id).await?["models"]
                .as_array()
                .is_some_and(|m| m.iter().any(|m| m == &q.model))
            {
                return Err(fault("所选 Key 无法使用此模型"));
            }
            let jobs = s
                .engine
                .query(json!({"op":"prepare","kind":q.kind,"variant":q.variant}))
                .await?;
            let jobs = if q.kind == "candy" {
                (0..q.runs).map(|_| jobs[0].clone()).collect::<Vec<_>>()
            } else {
                jobs.as_array()
                    .ok_or_else(|| fault("测试计划无效"))?
                    .clone()
            };
            let a = host::auth(
                h,
                "host.auth.get_runtime",
                json!({"account_id":q.account_id}),
            )
            .await?;
            let _guard = s.lock.lock().await;
            let history = histories(h).await?;
            let group_count = history
                .iter()
                .filter(|(_, v, _)| v["account_id"] == q.account_id && v["kind"] == q.kind)
                .count();
            let slot = (group_count >= GROUP_TARGET)
                .then(|| {
                    history
                        .iter()
                        .rev()
                        .find(|(_, r, _)| {
                            r["account_id"] == q.account_id
                                && r["kind"] == q.kind
                                && ["completed", "stopped"]
                                    .contains(&r["status"].as_str().unwrap_or(""))
                        })
                        .map(|(i, _, _)| *i)
                })
                .flatten()
                .or_else(|| (0..SLOTS).find(|slot| !history.iter().any(|(i, _, _)| i == slot)))
                .or_else(|| {
                    history
                        .iter()
                        .rev()
                        .find(|(_, r, _)| {
                            ["completed", "stopped"].contains(&r["status"].as_str().unwrap_or(""))
                        })
                        .map(|(i, _, _)| *i)
                })
                .ok_or_else(|| fault("历史槽位已满，请先停止未完成测试"))?;
            let version = history
                .iter()
                .find(|(i, _, _)| *i == slot)
                .map(|(_, _, v)| *v);
            let _slot_guard = s.slots[slot].lock().await;
            let r = json!({"id":format!("{}-{}",now(),slot),"slot":slot,"created_at":now(),"account_id":q.account_id,"account_name":account["name"],"account_email":account["email"],"account_plan":account["plan"],"key_id":q.key_id,"model":q.model,"kind":q.kind,"effort":q.effort,"variant":q.variant,"jobs":jobs,"attempts":[],"status":"ready","report":null,"identity":[a["authentication_kind"],a["upstream_user_id"],a["upstream_account_id"]],"credential_revision":a["credential_revision"]});
            if slot >= LEGACY_SLOTS {
                let current = host::read_key(h, "catalog").await?;
                let (mut catalog, catalog_version) =
                    current.map_or((json!({"slots":[]}), None), |(v, n)| (v, Some(n)));
                let slots = catalog["slots"]
                    .as_array_mut()
                    .ok_or_else(|| fault("历史索引无效"))?;
                if !slots.contains(&json!(slot)) {
                    slots.push(json!(slot));
                    // Reserve the index before the record so an interrupted write never hides history.
                    host::write_key(h, "catalog", &catalog, catalog_version).await?;
                }
            }
            host::write(h, slot, &r, version).await?;
            Ok(json!({"run":r}))
        }
        ("POST", "api/step") | ("POST", "api/stop") => {
            let q: Identity = input(c)?;
            if q.slot >= SLOTS {
                return Err(fault("历史槽位无效"));
            }
            let _guard = s.slots[q.slot].try_lock().map_err(|_| {
                PluginFault::new(ErrorCode::Conflict, "此轮测试正在执行，请稍后重试")
            })?;
            let (mut r, mut version) = host::read(h, q.slot)
                .await?
                .ok_or_else(|| fault("历史记录不存在"))?;
            if r["id"] != q.id {
                return Err(fault("此历史记录已被覆盖"));
            }
            if c.request.path == "api/stop" {
                if r["status"] != "completed" {
                    r["status"] = json!("stopped");
                    host::write(h, q.slot, &r, Some(version)).await?
                }
                return Ok(json!({"run":r}));
            }
            if r["status"] != "ready" {
                return Err(fault(
                    "测试不在可继续状态；中断的请求需停止后重新创建，以避免重复计费",
                ));
            }
            let _permit = s.parallel.try_acquire().map_err(|_| {
                PluginFault::new(ErrorCode::Capacity, "并发测试已达上限，请稍后重试")
            })?;
            let account = host::auth(
                h,
                "host.auth.get_runtime",
                json!({"account_id":r["account_id"]}),
            )
            .await?;
            if account["enabled"] != true
                || account["provider_id"] != "openai"
                || r["identity"]
                    != json!([
                        account["authentication_kind"],
                        account["upstream_user_id"],
                        account["upstream_account_id"]
                    ])
                || ((account["upstream_user_id"].is_null()
                    && account["upstream_account_id"].is_null())
                    && r["credential_revision"] != account["credential_revision"])
            {
                return Err(fault("账号已停用或身份发生变化，请新建测试"));
            }
            let index = r["attempts"]
                .as_array()
                .ok_or_else(|| fault("历史记录格式错误"))?
                .len();
            let job = r["jobs"][index].clone();
            if job.is_null() {
                return Err(fault("测试题目不存在"));
            }
            let body=s.engine.query(json!({"op":"request","account":r["account_id"],"model":r["model"],"effort":if r["kind"]=="fingerprint" {json!("none")}else{r["effort"].clone()},"job":job})).await?;
            r["status"] = json!("running");
            host::write(h, q.slot, &r, Some(version)).await?;
            version = host::read(h, q.slot)
                .await?
                .ok_or_else(|| fault("状态消失"))?
                .1;
            let began = now();
            let result = host::execute(h, &r, body).await;
            let mut attempt =
                json!({"index":index,"duration_ms":now()-began,"answer":"","status":"failed"});
            match result {
                Ok((id, Ok(out))) => {
                    attempt["request_id"] = json!(id);
                    attempt["response_id"] = out.response_id;
                    attempt["usage"] = out.usage;
                    let limit = match r["kind"].as_str() {
                        Some("candy") => 8192,
                        Some("fingerprint") => 64000,
                        _ => 262144,
                    };
                    if out.text.len() > limit {
                        attempt["error"] = json!("回答超过保存上限；不参与评分")
                    } else {
                        attempt["answer"] = json!(out.text);
                        attempt["status"] = json!("completed")
                    }
                }
                Ok((id, Err(e))) => {
                    attempt["request_id"] = json!(id);
                    attempt["error"] = json!(e.message.chars().take(400).collect::<String>())
                }
                Err(e) => attempt["error"] = json!(e.message.chars().take(400).collect::<String>()),
            }
            if r["kind"] == "candy" && attempt["status"] == "completed" {
                let result=s.engine.query(json!({"op":"score","kind":"candy","jobs":[job],"answers":[attempt["answer"]]})).await?;
                attempt["correct"] = result["correct"].clone();
            }
            r["attempts"].as_array_mut().unwrap().push(attempt);
            let complete = index + 1 == r["jobs"].as_array().unwrap().len();
            r["status"] = json!(if complete { "completed" } else { "ready" });
            if complete {
                let answers = r["attempts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|a| a["answer"].clone())
                    .collect::<Vec<_>>();
                if r["kind"] == "candy" {
                    let attempts = r["attempts"].as_array().unwrap();
                    r["report"] = json!({"correct":attempts.iter().filter(|a|a["correct"]==true).count(),"valid":attempts.iter().filter(|a|a["status"]=="completed").count(),"total":attempts.len()});
                } else {
                    r["report"]=match s.engine.query(json!({"op":"score","kind":r["kind"],"jobs":r["jobs"],"answers":answers})).await {Ok(v)=>v,Err(e)=>json!({"error":e.message})};
                }
            }
            if serde_json::to_vec(&r)
                .map_err(|_| fault("状态编码失败"))?
                .len()
                > 250 * 1024
            {
                r["report"] =
                    json!({"error":"结果超过 CPS 单条状态上限；回答原文未保存，请查看请求日志"});
                for a in r["attempts"].as_array_mut().unwrap() {
                    a["answer"] = json!("");
                    a["storage_note"] = json!("原文超过状态存储限制");
                }
            }
            host::write(h, q.slot, &r, Some(version)).await?;
            Ok(json!({"run":r}))
        }
        _ => Err(fault("接口不存在")),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parameters_are_bounded() {
        let mut q = Start {
            account_id: "a".into(),
            key_id: "k".into(),
            model: "gpt-6.1-sol".into(),
            kind: "candy".into(),
            effort: "low".into(),
            variant: "original".into(),
            runs: 1,
        };
        assert!(q.validate().is_ok());
        q.runs = 11;
        assert!(q.validate().is_err());
        q.runs = 1;
        q.model = "bad\nmodel".into();
        assert!(q.validate().is_err());
    }
}
