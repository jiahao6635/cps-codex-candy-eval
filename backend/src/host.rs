//! 宿主回调、指定账号请求及响应流读取

use crate::fault;
use gateway_plugin_sdk::{
    PluginFault,
    call::{host::*, model::WirePayload},
    client::HostClient,
};
use serde_json::{Value, json};

pub async fn meta(host: &HostClient, method: &str, params: Value) -> Result<Value, PluginFault> {
    let r = host
        .call(method, params, vec![])
        .await
        .map_err(|e| e.into_plugin_fault())?;
    if !r.payload.is_empty() {
        return Err(fault("宿主元数据回调包含意外正文"));
    }
    Ok(r.result)
}
pub async fn auth(host: &HostClient, method: &str, params: Value) -> Result<Value, PluginFault> {
    let r = host
        .call(
            method,
            json!({}),
            serde_json::to_vec(&params).map_err(|_| fault("请求编码失败"))?,
        )
        .await
        .map_err(|e| e.into_plugin_fault())?;
    serde_json::from_slice(&r.payload).map_err(|_| fault("账号回调返回无效 JSON"))
}
pub async fn list(host: &HostClient, accounts: bool) -> Result<Vec<Value>, PluginFault> {
    let mut cursor = Value::Null;
    let mut seen = std::collections::BTreeSet::new();
    let mut values = vec![];
    loop {
        let page = if accounts {
            auth(
                host,
                "host.auth.list",
                json!({"provider_id":"openai","cursor":cursor,"limit":100}),
            )
            .await?
        } else {
            meta(host, "host.keys.list", json!({"cursor":cursor,"limit":100})).await?
        };
        let items = page[if accounts { "accounts" } else { "keys" }]
            .as_array()
            .ok_or_else(|| fault("宿主列表格式错误"))?;
        // Only return display facts; never expose credential material to the iframe.
        for a in items.iter().filter(|a| accounts || a["enabled"] == true) {
            values.push(if accounts {json!({"id":a["account_id"],"name":a["name"],"email":a["email"],"plan":a["plan_type"],"enabled":a["enabled"]})} else {json!({"id":a["id"],"name":a["name"]})});
        }
        cursor = page["next_cursor"].clone();
        if cursor.is_null() {
            return Ok(values);
        }
        if !seen.insert(cursor.to_string()) || seen.len() > 100 {
            return Err(fault("宿主列表分页异常"));
        }
    }
}
pub async fn models(host: &HostClient, key: &str) -> Result<Value, PluginFault> {
    meta(
        host,
        "host.models.list",
        json!({"client_key_id":key,"protocol":"openai","client_version":concat!("codex-candy-eval/",env!("CARGO_PKG_VERSION"))}),
    )
    .await
}
pub async fn read(host: &HostClient, slot: usize) -> Result<Option<(Value, u64)>, PluginFault> {
    let r = meta(
        host,
        "host.state.get",
        json!({"namespace":"history","key":slot.to_string()}),
    )
    .await?;
    if r["record"].is_null() {
        return Ok(None);
    }
    Ok(Some((
        r["record"]["value"].clone(),
        r["record"]["version"]
            .as_u64()
            .ok_or_else(|| fault("状态版本缺失"))?,
    )))
}
pub async fn write(
    host: &HostClient,
    slot: usize,
    value: &Value,
    version: Option<u64>,
) -> Result<(), PluginFault> {
    meta(host,"host.state.put",json!({"namespace":"history","key":slot.to_string(),"value":value,"expected_version":version})).await?;
    Ok(())
}

#[derive(Default)]
pub struct Output {
    pub text: String,
    pub usage: Value,
    pub response_id: Value,
}
fn consume(data: Value, out: &mut Output, complete: &mut bool) -> Result<(), PluginFault> {
    match data["type"].as_str().unwrap_or("") {
        "response.completed" => {
            if data["response"]["status"] != "completed" {
                return Err(fault("模型响应未正常完成"));
            }
            out.text = data["response"]["output"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|v| v["type"] == "message" && v["role"] == "assistant")
                .flat_map(|v| v["content"].as_array().into_iter().flatten())
                .filter(|v| v["type"] == "output_text")
                .filter_map(|v| v["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            out.usage = data["response"]["usage"].clone();
            out.response_id = data["response"]["id"].clone();
            *complete = true;
        }
        "response.failed" | "response.incomplete" | "error" => {
            return Err(fault("上游模型返回失败或不完整响应；请查看 CPS 请求日志"));
        }
        _ => {}
    };
    Ok(())
}
fn parse_sse(
    buffer: &mut String,
    out: &mut Output,
    complete: &mut bool,
) -> Result<(), PluginFault> {
    while let Some(end) = buffer.find("\n\n") {
        let frame = buffer[..end].to_owned();
        buffer.drain(..end + 2);
        let data = frame
            .lines()
            .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        consume(
            serde_json::from_str(&data).map_err(|_| fault("SSE 数据格式错误"))?,
            out,
            complete,
        )?;
    }
    Ok(())
}
pub async fn execute(
    host: &HostClient,
    run: &Value,
    body: Value,
) -> Result<(String, Result<Output, PluginFault>), PluginFault> {
    // 建立流和读取共用期限，另留 35 秒用于关闭、评分及状态保存
    let budget = host
        .remaining_budget()
        .unwrap_or(std::time::Duration::from_secs(170));
    let model_budget = budget
        .saturating_sub(std::time::Duration::from_secs(35))
        .min(std::time::Duration::from_secs(120));
    if model_budget.is_zero() {
        return Err(fault("剩余调用时间不足，请稍后重新测试"));
    }
    let deadline = tokio::time::Instant::now() + model_budget;
    let reply=tokio::time::timeout_at(deadline, host.call("host.model.execute_stream",json!({"client_key_id":run["key_id"],"model":run["model"],"protocol":"openai","operation":"generate","provider":"openai","account_id":run["account_id"]}),serde_json::to_vec(&body).map_err(|_|fault("模型请求编码失败"))?)).await.map_err(|_| fault("模型请求建立超时；请查看 CPS 请求日志"))?.map_err(|e|e.into_plugin_fault())?;
    let stream: ModelStreamResult =
        serde_json::from_value(reply.result).map_err(|_| fault("模型流信息错误"))?;
    let mut ended = false;
    let result = tokio::time::timeout_at(deadline, async {
        let mut out = Output::default();
        let mut complete = false;
        let mut buffer = String::new();
        let mut total = 0;
        loop {
            let reply = host
                .call(
                    "host.model.stream_read",
                    json!({"stream":stream.stream,"maximum_bytes":262144}),
                    vec![],
                )
                .await
                .map_err(|e| e.into_plugin_fault())?;
            let state: ModelStreamReadResult =
                serde_json::from_value(reply.result).map_err(|_| fault("模型流状态错误"))?;
            ended = state.end;
            let batch = if reply.payload.is_empty() && state.events == 0 {
                ModelEventBatch::default()
            } else {
                ModelEventBatch::decode(&reply.payload).map_err(|_| fault("模型事件格式错误"))?
            };
            if batch.events.len() != state.events as usize {
                return Err(fault("模型事件数量不一致"));
            }
            total += reply.payload.len();
            if total > 4 * 1024 * 1024 {
                return Err(fault("模型响应超过 4 MiB"));
            }
            for event in batch.events {
                if let Some(wire) = event.wire {
                    if wire.protocol != "openai" {
                        return Err(fault("模型返回不匹配的协议"));
                    }
                    match wire.payload {
                        WirePayload::Json { data, .. } => consume(data, &mut out, &mut complete)?,
                        WirePayload::WebSocket { data, message, .. } => {
                            let data = match data {
                                Some(data) => data,
                                None => serde_json::from_slice(&message)
                                    .map_err(|_| fault("WebSocket 模型消息不是有效 JSON"))?,
                            };
                            consume(data, &mut out, &mut complete)?;
                        }
                        WirePayload::RawSse { frame } => {
                            buffer.push_str(
                                std::str::from_utf8(&frame).map_err(|_| fault("SSE 编码错误"))?,
                            );
                            buffer = buffer.replace("\r\n", "\n");
                            parse_sse(&mut buffer, &mut out, &mut complete)?;
                        }
                        _ => return Err(fault("模型没有返回 Responses SSE")),
                    }
                }
            }
            if state.end {
                if !complete || out.text.trim().is_empty() {
                    return Err(fault("模型未返回完整文本；不计作答错"));
                }
                return Ok(out);
            }
        }
    })
    .await
    .unwrap_or_else(|_| Err(fault("模型请求超时")));
    // EOF 时宿主已经释放句柄，仅关闭尚未结束的流；父调用结束仍会回收剩余资源
    if !ended {
        let close = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            host.call(
                "host.model.stream_close",
                json!({"stream":stream.stream}),
                vec![],
            ),
        )
        .await;
        if !matches!(close, Ok(Ok(_))) {
            return Ok((
                stream.request_id,
                Err(fault("模型请求失败，且关闭流失败；请检查 CPS 日志")),
            ));
        }
    }
    Ok((stream.request_id, result))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fragmented_sse_requires_completed_assistant_text() {
        let mut b = String::from(
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"21\"}]}]}}",
        );
        let mut o = Output::default();
        let mut done = false;
        parse_sse(&mut b, &mut o, &mut done).unwrap();
        assert!(!done);
        b.push_str("\n\n");
        parse_sse(&mut b, &mut o, &mut done).unwrap();
        assert!(done);
        assert_eq!(o.text, "21");
        assert!(consume(json!({"type":"response.incomplete"}), &mut o, &mut done).is_err());
    }
}
