//! CPS 插件进程握手与会话入口

use gateway_plugin_sdk::client::{PluginSession, SessionConfig};
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut session = PluginSession::accept(
        tokio::io::stdin(),
        tokio::io::stdout(),
        SessionConfig::default(),
    )
    .await?;
    if session.handshake().plugin_id != "local.codex-candy-eval" {
        return Err("插件身份不匹配".into());
    }
    session.set_call_budgets(
        [(
            gateway_plugin_sdk::Stage::Management,
            cps_codex_candy_eval::MANAGEMENT_TIMEOUT_MS,
        )]
        .into(),
    )?;
    session.run(cps_codex_candy_eval::plugin()?).await?;
    Ok(())
}
