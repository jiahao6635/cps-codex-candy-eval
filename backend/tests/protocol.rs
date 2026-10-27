//! 指定账号调用、状态持久化和请求失败分类的协议集成测试

use gateway_plugin_sdk::{
    CallContext, Frame, Handshake, Manifest, Message, RequestContext, Stage,
    call::{
        host::ModelEventBatch,
        model::{ExecutionEvent, WireEvent, WirePayload},
    },
    client::{PluginSession, SessionConfig, read_frame, write_frame},
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc};
use tokio::io::{AsyncRead, AsyncWrite};
trait Transport: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Transport for T {}
#[derive(Clone, Copy)]
enum WireMode {
    Json,
    Sse,
    WebSocket,
    RawWebSocket,
    InvalidWebSocket,
}
struct Harness {
    wire_mode: WireMode,
    io: Box<dyn Transport>,
    task: tokio::task::JoinHandle<()>,
    records: BTreeMap<String, (Value, u64)>,
    accounts: Vec<Value>,
    requests: Vec<(Value, Value)>,
    fail: bool,
    end: bool,
    stream_open: bool,
    stream_closes: usize,
    sequence: u64,
    timeout_ms: u64,
    delays: BTreeMap<&'static str, (u64, bool)>,
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.task.abort()
    }
}
impl Harness {
    async fn new(wire_mode: WireMode) -> Self {
        Self::connect(wire_mode, std::env::var("CANDY_TEST_PLUGIN").ok()).await
    }
    async fn connect(wire_mode: WireMode, executable: Option<String>) -> Self {
        let (mut io, task): (Box<dyn Transport>, _) = if let Some(executable) = executable {
            let mut command = tokio::process::Command::new(executable);
            command
                .env_clear()
                .current_dir(std::env::var("CANDY_TEST_DIRECTORY").unwrap())
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::inherit())
                .kill_on_drop(true);
            let mut child = command.spawn().unwrap();
            let reader = child.stdout.take().unwrap();
            let writer = child.stdin.take().unwrap();
            (
                Box::new(tokio::io::join(reader, writer)),
                tokio::spawn(async move {
                    let _ = child.wait().await;
                }),
            )
        } else {
            let (io, plugin_io) = tokio::io::duplex(4 * 1024 * 1024);
            let plugin = cps_codex_candy_eval::plugin().unwrap();
            let task = tokio::spawn(async move {
                let (r, w) = tokio::io::split(plugin_io);
                let mut session = PluginSession::accept(r, w, SessionConfig::default())
                    .await
                    .unwrap();
                session
                    .set_call_budgets(
                        [(
                            Stage::Management,
                            cps_codex_candy_eval::MANAGEMENT_TIMEOUT_MS,
                        )]
                        .into(),
                    )
                    .unwrap();
                session.run(plugin).await.unwrap();
            });
            (Box::new(io), task)
        };
        let manifest = Manifest::from_author_slice(include_bytes!("../../plugin.json")).unwrap();
        write_frame(
            &mut io,
            &Frame::control(Message::Hello {
                handshake: Handshake {
                    protocol_version: 7,
                    artifact_sha256: "b".repeat(64),
                    plugin_id: "local.codex-candy-eval".into(),
                    instance_id: "fixture".into(),
                    generation: 1,
                    incarnation: "fixture".into(),
                    configuration: json!({}),
                    contributes: manifest.contributes,
                },
            }),
        )
        .await
        .unwrap();
        match read_frame(&mut io).await.unwrap().message {
            Message::Ready {
                protocol_version,
                call_budgets,
                ..
            } => {
                assert_eq!(protocol_version, 7);
                assert_eq!(call_budgets[&Stage::Management], 170_000);
            }
            _ => panic!("plugin did not complete RPC v7 handshake"),
        }
        Self {
            io,
            task,
            records: BTreeMap::new(),
            accounts: vec![account()],
            requests: vec![],
            fail: false,
            end: true,
            stream_open: false,
            stream_closes: 0,
            wire_mode,
            sequence: 1,
            timeout_ms: cps_codex_candy_eval::MANAGEMENT_TIMEOUT_MS,
            delays: BTreeMap::new(),
        }
    }
    async fn api(&mut self, path: &str, body: Option<Value>) -> (u64, Value) {
        let call_id = self.sequence;
        self.sequence += 2;
        let method = if body.is_some() { "POST" } else { "GET" };
        write_frame(&mut self.io,&Frame{message:Message::Call{id:call_id,method:"management.handle".into(),context:CallContext{call_id,instance_id:"fixture".into(),generation:1,incarnation:"fixture".into(),stage:Stage::Management,timeout_ms:self.timeout_ms,resource_stream:false,resource_scope_id:"fixture".into(),request_id:None,attempt_id:None,account_id:None,credential_revision:None,request:Some(Arc::new(RequestContext{method:method.into(),uri:format!("/api/plugins/fixture/{path}"),http_version:"HTTP/1.1".into(),headers:vec![gateway_plugin_sdk::call::middleware::MiddlewareHeader{name:"x-fixture".into(),value:vec![0xff,0x80]}],peer_addr:None,client_ip:None}))},params:json!({"method":method,"path":path,"query":"","content_type":body.as_ref().map(|_|"application/json"),"headers":[]})},payload:body.map(|v|serde_json::to_vec(&v).unwrap()).unwrap_or_default()}).await.unwrap();
        loop {
            let frame =
                tokio::time::timeout(std::time::Duration::from_secs(20), read_frame(&mut self.io))
                    .await
                    .unwrap()
                    .unwrap();
            match frame.message {
                Message::Callback {
                    id, method, params, ..
                } => {
                    let (result, payload) = self.callback(&method, params, frame.payload);
                    if let Some((seconds, respond)) = self.delays.remove(method.as_str()) {
                        // 只在进程内会话推进 Tokio 时间，模拟宿主长时间没有返回回调
                        tokio::time::pause();
                        tokio::time::advance(std::time::Duration::from_secs(seconds)).await;
                        tokio::time::resume();
                        if !respond {
                            continue;
                        }
                    }
                    write_frame(
                        &mut self.io,
                        &Frame {
                            message: Message::Result { id, result },
                            payload,
                        },
                    )
                    .await
                    .unwrap();
                }
                Message::Suspend { id, epoch } => {
                    assert_eq!(id, call_id);
                    assert!(epoch > 0);
                }
                Message::Resume { id, epoch } => {
                    assert_eq!(id, call_id);
                    write_frame(
                        &mut self.io,
                        &Frame::control(Message::Resumed { id, epoch }),
                    )
                    .await
                    .unwrap();
                }
                Message::CallbackConsumed { parent_id, .. } => {
                    assert_eq!(parent_id, call_id);
                }
                Message::Result { result, .. } => {
                    return (
                        result["status"].as_u64().unwrap(),
                        serde_json::from_slice(&frame.payload).unwrap(),
                    );
                }
                _ => panic!("unexpected protocol message"),
            }
        }
    }
    fn callback(&mut self, method: &str, p: Value, body: Vec<u8>) -> (Value, Vec<u8>) {
        match method {
            "host.auth.list" => (
                json!({}),
                serde_json::to_vec(&json!({"accounts":self.accounts,"next_cursor":null})).unwrap(),
            ),
            "host.auth.get_runtime" => {
                let q: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(q["account_id"], "a");
                (json!({}), serde_json::to_vec(&account()).unwrap())
            }
            "host.keys.list" => (
                json!({"keys":[{"id":"k","name":"Test key","enabled":true}],"next_cursor":null}),
                vec![],
            ),
            "host.models.list" => {
                assert_eq!(p["client_key_id"], "k");
                (json!({"models":["test-model"]}), vec![])
            }
            "host.state.get" => {
                let record = self
                    .records
                    .get(p["key"].as_str().unwrap())
                    .map(|(v, rev)| json!({"value":v,"version":rev,"schema_version":1}));
                (json!({"record":record}), vec![])
            }
            "host.state.put" => {
                let key = p["key"].as_str().unwrap().to_owned();
                let rev = self.records.get(&key).map(|(_, v)| *v);
                assert_eq!(p["expected_version"], json!(rev));
                let version = rev.unwrap_or(0) + 1;
                self.records.insert(key, (p["value"].clone(), version));
                (json!({"version":version}), vec![])
            }
            "host.model.execute_stream" => {
                assert!(!self.stream_open);
                self.stream_open = true;
                assert_eq!(p["client_key_id"], "k");
                assert_eq!(p["account_id"], "a");
                assert_eq!(p["provider"], "openai");
                let body: Value = serde_json::from_slice(&body).unwrap();
                assert!(body["input"].as_array().unwrap().len() >= 6);
                self.requests.push((p, body));
                (
                    json!({"stream":"stream-1","request_id":"request-1"}),
                    vec![],
                )
            }
            "host.model.stream_read" => {
                assert!(self.stream_open);
                if self.end {
                    self.stream_open = false;
                }
                let data = if self.fail {
                    json!({"type":"response.incomplete"})
                } else {
                    json!({"type":"response.completed","response":{"id":"response-1","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"答案为 21。"}]}],"usage":{"input_tokens":123,"output_tokens":8}}})
                };
                let batch = ModelEventBatch {
                    events: vec![ExecutionEvent {
                        facts: vec![],
                        host: None,
                        wire: Some(WireEvent {
                            protocol: "openai".into(),
                            payload: match self.wire_mode {
                                WireMode::Json => WirePayload::Json {
                                    data,
                                    event: None,
                                    id: None,
                                    retry: None,
                                    raw_sse: None,
                                },
                                WireMode::Sse => WirePayload::RawSse {
                                    frame: format!("data: {}\n\n", data).into_bytes(),
                                },
                                WireMode::WebSocket => WirePayload::WebSocket {
                                    event: None,
                                    message: serde_json::to_vec(&data).unwrap(),
                                    data: Some(data),
                                },
                                WireMode::RawWebSocket => WirePayload::WebSocket {
                                    event: None,
                                    message: serde_json::to_vec(&data).unwrap(),
                                    data: None,
                                },
                                WireMode::InvalidWebSocket => WirePayload::WebSocket {
                                    event: None,
                                    message: b"not-json".to_vec(),
                                    data: None,
                                },
                            },
                        }),
                    }],
                };
                (json!({"events":1,"end":self.end}), batch.encode().unwrap())
            }
            "host.model.stream_close" => {
                assert!(
                    self.stream_open,
                    "EOF already releases the host stream handle"
                );
                self.stream_open = false;
                self.stream_closes += 1;
                (json!({}), vec![])
            }
            _ => panic!("unexpected callback {method}"),
        }
    }
}
fn account() -> Value {
    json!({"account_id":"a","provider_id":"openai","name":"Fixture account","email":null,"plan_type":"pro","enabled":true,"authentication_kind":"oauth","upstream_user_id":"user-a","upstream_account_id":"org-a","credential_revision":1})
}
fn start() -> Value {
    json!({"account_id":"a","key_id":"k","model":"test-model","kind":"candy","effort":"low","variant":"original","runs":1})
}
#[tokio::test]
async fn pinned_account_persistence_and_failure_classification() {
    for wire_mode in [
        WireMode::Json,
        WireMode::Sse,
        WireMode::WebSocket,
        WireMode::RawWebSocket,
    ] {
        let mut h = Harness::new(wire_mode).await;
        let (status, b) = h.api("api/start", Some(start())).await;
        assert_eq!(status, 200, "{b}");
        let id = json!({"id":b["run"]["id"],"slot":b["run"]["slot"]});
        let (status, b) = h.api("api/step", Some(id.clone())).await;
        assert_eq!(status, 200, "{b}");
        assert_eq!(b["run"]["report"]["correct"], 1);
        assert_eq!(h.requests.len(), 1);
        let (status, _) = h.api("api/step", Some(id)).await;
        assert_eq!(status, 400);
        assert_eq!(h.requests.len(), 1);
        let (_, history) = h.api("api/history", None).await;
        assert_eq!(history["runs"][0]["attempts"][0]["request_id"], "request-1");
        h.fail = true;
        let (_, b) = h.api("api/start", Some(start())).await;
        let id = json!({"id":b["run"]["id"],"slot":b["run"]["slot"]});
        let (_, b) = h.api("api/step", Some(id)).await;
        assert_eq!(b["run"]["report"]["valid"], 0);
        assert_eq!(b["run"]["attempts"][0]["status"], "failed");
        assert_eq!(b["run"]["report"]["correct"], 0);
        assert!(
            b["run"]["attempts"][0]["error"]
                .as_str()
                .unwrap()
                .contains("不完整响应")
        );
        assert_eq!(h.stream_closes, 0);
    }
}

#[tokio::test]
async fn invalid_websocket_is_request_failure_not_wrong_answer() {
    let mut h = Harness::new(WireMode::InvalidWebSocket).await;
    h.end = false;
    let (status, body) = h.api("api/start", Some(start())).await;
    assert_eq!(status, 200);
    let identity = json!({"id":body["run"]["id"],"slot":body["run"]["slot"]});
    let (status, body) = h.api("api/step", Some(identity)).await;
    assert_eq!(status, 200);
    assert_eq!(body["run"]["report"]["valid"], 0);
    assert_eq!(body["run"]["attempts"][0]["status"], "failed");
    assert_eq!(h.requests.len(), 1);
    assert_eq!(h.stream_closes, 1);
    assert!(!h.stream_open);
}

#[tokio::test]
async fn account_facts_and_legacy_history_are_readable_without_bulk_answers() {
    let mut h = Harness::new(WireMode::Json).await;
    h.accounts[0]["name"] = json!("openai OAuth");
    h.accounts[0]["email"] = json!("us-east@example.invalid");
    h.accounts[0]["material"] = json!({"access_token":"must-not-be-returned"});
    let mut disabled = account();
    disabled["account_id"] = json!("disabled");
    disabled["enabled"] = json!(false);
    h.accounts.push(disabled);
    let (status, body) = h.api("api/bootstrap", None).await;
    assert_eq!(status, 200);
    assert_eq!(body["accounts"].as_array().unwrap().len(), 2);
    assert_eq!(body["accounts"][0]["email"], "us-east@example.invalid");
    assert_eq!(body["accounts"][1]["enabled"], false);
    assert!(!body.to_string().contains("must-not-be-returned"));
    let mut request = start();
    request["account_id"] = json!("disabled");
    assert_eq!(h.api("api/start", Some(request)).await.0, 400);
    assert!(h.requests.is_empty());

    // 旧 schema v1 的全量历史包含正文但没有邮箱快照，读取不能修改保存内容
    for slot in 0..64 {
        let run = json!({"id":format!("legacy-{slot}"),"slot":slot,"created_at":slot,"account_id":if slot%2==0 {"a"}else{"removed"},"account_name":"openai OAuth","kind":"pelican","status":"completed","jobs":[{"prompt":"private-job"}],"identity":["private-identity"],"credential_revision":1,"attempts":[{"answer":"A".repeat(100_000),"status":"completed"}],"report":{"html":"<svg>drawing</svg>"}});
        h.records.insert(slot.to_string(), (run, 7));
    }
    let original = h.records.clone();
    let (status, history) = h.api("api/history", None).await;
    assert_eq!(status, 200);
    let rows = history["runs"].as_array().unwrap();
    assert_eq!(rows.len(), 64);
    assert_eq!(rows[0]["id"], "legacy-63");
    assert_eq!(rows[0]["account_id"], "removed");
    assert_eq!(rows[0]["has_drawing"], true);
    assert!(rows[0]["jobs"].is_null());
    assert!(rows[0]["attempts"][0]["answer"].is_null());
    assert!(rows[0]["report"]["html"].is_null());
    assert!(serde_json::to_vec(&history).unwrap().len() < 64 * 1024);
    let (status, detail) = h
        .api("api/run", Some(json!({"id":"legacy-63","slot":63})))
        .await;
    assert_eq!(status, 200);
    assert_eq!(
        detail["run"]["attempts"][0]["answer"]
            .as_str()
            .unwrap()
            .len(),
        100_000
    );
    assert_eq!(detail["run"]["report"]["html"], "<svg>drawing</svg>");
    assert!(detail["run"]["identity"].is_null());
    assert_eq!(h.records, original);
    assert_eq!(
        h.api("api/run", Some(json!({"id":"overwritten","slot":63})))
            .await
            .0,
        400
    );
    assert_eq!(
        h.api("api/run", Some(json!({"id":"legacy-63","slot":64})))
            .await
            .0,
        400
    );
    assert!(h.requests.is_empty());

    let (status, body) = h.api("api/start", Some(start())).await;
    assert_eq!(status, 200);
    assert_eq!(body["run"]["account_email"], "us-east@example.invalid");
    assert_eq!(body["run"]["account_plan"], "pro");
    assert_eq!(h.records.get("1"), original.get("1"));
}

#[tokio::test]
async fn short_parent_budget_saves_failure_without_submitting_model() {
    let mut h = Harness::new(WireMode::Json).await;
    let (_, body) = h.api("api/start", Some(start())).await;
    let identity = json!({"id":body["run"]["id"],"slot":body["run"]["slot"]});
    h.timeout_ms = 5_000;
    let (status, body) = h.api("api/step", Some(identity.clone())).await;
    assert_eq!(status, 200);
    assert_eq!(body["run"]["status"], "completed");
    assert_eq!(body["run"]["report"]["valid"], 0);
    assert!(
        body["run"]["attempts"][0]["error"]
            .as_str()
            .unwrap()
            .contains("时间不足")
    );
    assert!(h.requests.is_empty());
    let (_, saved) = h.api("api/run", Some(identity)).await;
    assert_eq!(saved["run"]["attempts"][0]["status"], "failed");
}

#[tokio::test]
async fn model_deadline_includes_establishment_and_preserves_failure() {
    // 虚拟时间只作用于当前进程，实际归档进程由其他协议用例覆盖
    for establish_timeout in [true, false] {
        let mut h = Harness::connect(WireMode::Json, None).await;
        h.end = false;
        h.delays.insert(
            "host.model.execute_stream",
            (if establish_timeout { 121 } else { 70 }, !establish_timeout),
        );
        if !establish_timeout {
            h.delays.insert("host.model.stream_read", (60, false));
        }
        let (_, body) = h.api("api/start", Some(start())).await;
        let identity = json!({"id":body["run"]["id"],"slot":body["run"]["slot"]});
        let (status, body) = h.api("api/step", Some(identity.clone())).await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["run"]["status"], "completed");
        assert_eq!(body["run"]["report"]["valid"], 0);
        assert!(
            body["run"]["attempts"][0]["error"]
                .as_str()
                .unwrap()
                .contains("超时")
        );
        assert_eq!(h.stream_closes, usize::from(!establish_timeout));
        if !establish_timeout {
            assert_eq!(body["run"]["attempts"][0]["request_id"], "request-1");
        }
        assert_eq!(h.api("api/step", Some(identity.clone())).await.0, 400);
        assert_eq!(h.requests.len(), 1);
        let (_, saved) = h.api("api/run", Some(identity)).await;
        assert_eq!(saved["run"]["attempts"][0]["status"], "failed");
    }
}
