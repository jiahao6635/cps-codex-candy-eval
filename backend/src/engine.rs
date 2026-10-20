//! 离线 Go 评分引擎的启动与有界通信

use crate::fault;
use gateway_plugin_sdk::PluginFault;
use serde_json::Value;
use std::{io::Write, os::unix::fs::OpenOptionsExt, process::Stdio};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct Engine(std::path::PathBuf);
impl Engine {
    pub fn bundled() -> std::io::Result<Self> {
        let path = std::env::current_dir()?.join(format!(
            ".candy-engine-{}-{}",
            std::process::id(),
            crate::now()
        ));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o700)
            .open(&path)?;
        file.write_all(include_bytes!(env!("CANDY_ENGINE_BINARY")))?;
        Ok(Self(path))
    }
    pub async fn query(&self, value: Value) -> Result<Value, PluginFault> {
        tokio::time::timeout(std::time::Duration::from_secs(20), async {
            let mut child = tokio::process::Command::new(&self.0)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .map_err(|_| fault("评分引擎启动失败"))?;
            let mut input = child.stdin.take().ok_or_else(|| fault("引擎输入缺失"))?;
            let mut raw = serde_json::to_vec(&value).map_err(|_| fault("引擎输入编码失败"))?;
            raw.push(b'\n');
            input
                .write_all(&raw)
                .await
                .map_err(|_| fault("引擎输入失败"))?;
            drop(input);
            let mut bytes = vec![];
            child
                .stdout
                .take()
                .ok_or_else(|| fault("引擎输出缺失"))?
                .take(2 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| fault("引擎输出失败"))?;
            if bytes.len() > 2 * 1024 * 1024 {
                return Err(fault("引擎输出超限"));
            }
            let status = child.wait().await.map_err(|_| fault("引擎退出失败"))?;
            let output: Value =
                serde_json::from_slice(&bytes).map_err(|_| fault("引擎返回无效 JSON"))?;
            if !status.success() || output["ok"] != true {
                return Err(fault(output["error"].as_str().unwrap_or("引擎运行失败")));
            }
            Ok(output["data"].clone())
        })
        .await
        .map_err(|_| fault("评分引擎超时"))?
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
