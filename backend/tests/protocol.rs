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
struct Harness {
    io: Box<dyn Transport>,
    task: tokio::task::JoinHandle<()>,
    records: BTreeMap<String, (Value, u64)>,
    requests: Vec<(Value, Value)>,
    fail: bool,
    sequence: u64,
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.task.abort()
    }
}
impl Harness {
    async fn new() -> Self {
        let (mut io, task): (Box<dyn Transport>, _) =
            if let Ok(executable) = std::env::var("CANDY_TEST_PLUGIN") {
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
                    PluginSession::accept(r, w, SessionConfig::default())
                        .await
                        .unwrap()
                        .run(plugin)
                        .await
                        .unwrap();
                });
                (Box::new(io), task)
            };
        let manifest = Manifest::from_author_slice(include_bytes!("../../plugin.json")).unwrap();
        write_frame(
            &mut io,
            &Frame::control(Message::Hello {
                handshake: Handshake {
                    protocol_version: 4,
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
        assert!(matches!(
            read_frame(&mut io).await.unwrap().message,
            Message::Ready {
                protocol_version: 4,
                ..
            }
        ));
        Self {
            io,
            task,
            records: BTreeMap::new(),
            requests: vec![],
            fail: false,
            sequence: 1,
        }
    }
    async fn api(&mut self, path: &str, body: Option<Value>) -> (u64, Value) {
        let call_id = self.sequence;
        self.sequence += 2;
        let method = if body.is_some() { "POST" } else { "GET" };
        write_frame(&mut self.io,&Frame{message:Message::Call{id:call_id,method:"management.handle".into(),context:CallContext{call_id,instance_id:"fixture".into(),generation:1,incarnation:"fixture".into(),stage:Stage::Management,timeout_ms:120000,resource_stream:false,resource_scope_id:"fixture".into(),request_id:None,attempt_id:None,account_id:None,credential_revision:None,request:Some(Arc::new(RequestContext{method:method.into(),uri:format!("/api/plugins/fixture/{path}"),http_version:"HTTP/1.1".into(),headers:vec![],peer_addr:None,client_ip:None}))},params:json!({"method":method,"path":path,"query":"","content_type":body.as_ref().map(|_|"application/json"),"headers":[]})},payload:body.map(|v|serde_json::to_vec(&v).unwrap()).unwrap_or_default()}).await.unwrap();
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
                serde_json::to_vec(&json!({"accounts":[account()],"next_cursor":null})).unwrap(),
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
                            payload: WirePayload::Json {
                                data,
                                event: None,
                                id: None,
                                retry: None,
                                raw_sse: None,
                            },
                        }),
                    }],
                };
                (json!({"events":1,"end":true}), batch.encode().unwrap())
            }
            "host.model.stream_close" => (json!({}), vec![]),
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
    let mut h = Harness::new().await;
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
}
