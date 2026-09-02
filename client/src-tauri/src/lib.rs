use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, State};

struct Database(Mutex<Connection>);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BaziRecord {
    pub id: Option<String>, pub name: String, pub gender: String, pub birth_year: i32, pub birth_month: i32,
    pub created_at: String,
    pub year_pillar: String, pub month_pillar: String, pub day_pillar: String, pub hour_pillar: String,
    pub non_ai_result: Option<String>, pub ai_status: String, pub ai_analysis: Option<String>, pub ai_overview: Option<String>, pub ai_error: Option<String>, pub ai_tasks: Option<String>,
}

fn initialize(connection: &Connection) -> Result<(), String> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS bazi_records (id TEXT PRIMARY KEY, name TEXT NOT NULL, gender TEXT NOT NULL, birth_year INTEGER NOT NULL, birth_month INTEGER NOT NULL, created_at TEXT NOT NULL, year_pillar TEXT NOT NULL, month_pillar TEXT NOT NULL, day_pillar TEXT NOT NULL, hour_pillar TEXT NOT NULL, non_ai_result TEXT, ai_status TEXT NOT NULL, ai_analysis TEXT, ai_overview TEXT, ai_error TEXT, ai_tasks TEXT)").map_err(|e| e.to_string())?;
    // 命中缓存：同一八字+性别+任务+年份的 AI 结果只算一次(成本优化)。
    connection.execute("CREATE TABLE IF NOT EXISTS ai_cache (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)", []).map_err(|e| e.to_string())?;
    let has_created_at = connection.prepare("SELECT 1 FROM pragma_table_info('bazi_records') WHERE name = ?1").and_then(|mut statement| statement.exists(["created_at"])).map_err(|e| e.to_string())?;
    if !has_created_at {
        connection.execute("ALTER TABLE bazi_records ADD COLUMN created_at TEXT NOT NULL DEFAULT ''", []).map_err(|e| e.to_string())?;
        connection.execute("UPDATE bazi_records SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE created_at = ''", []).map_err(|e| e.to_string())?;
    }
    let has_non_ai_result = connection.prepare("SELECT 1 FROM pragma_table_info('bazi_records') WHERE name = ?1").and_then(|mut statement| statement.exists(["non_ai_result"])).map_err(|e| e.to_string())?;
    if !has_non_ai_result { connection.execute("ALTER TABLE bazi_records ADD COLUMN non_ai_result TEXT", []).map_err(|e| e.to_string())?; }
    let has_ai_tasks = connection.prepare("SELECT 1 FROM pragma_table_info('bazi_records') WHERE name = ?1").and_then(|mut statement| statement.exists(["ai_tasks"])).map_err(|e| e.to_string())?;
    if !has_ai_tasks { connection.execute("ALTER TABLE bazi_records ADD COLUMN ai_tasks TEXT", []).map_err(|e| e.to_string())?; }
    let has_ai_overview = connection.prepare("SELECT 1 FROM pragma_table_info('bazi_records') WHERE name = ?1").and_then(|mut statement| statement.exists(["ai_overview"])).map_err(|e| e.to_string())?;
    if !has_ai_overview { connection.execute("ALTER TABLE bazi_records ADD COLUMN ai_overview TEXT", []).map_err(|e| e.to_string())?; }
    Ok(())
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<BaziRecord> {
    Ok(BaziRecord { id: Some(row.get(0)?), name: row.get(1)?, gender: row.get(2)?, birth_year: row.get(3)?, birth_month: row.get(4)?, created_at: row.get(5)?, year_pillar: row.get(6)?, month_pillar: row.get(7)?, day_pillar: row.get(8)?, hour_pillar: row.get(9)?, non_ai_result: row.get(10)?, ai_status: row.get(11)?, ai_analysis: row.get(12)?, ai_overview: row.get(13)?, ai_error: row.get(14)?, ai_tasks: row.get(15)? })
}

mod commands {
use super::*;

const KEYRING_SERVICE: &str = "mingli-client";
const SELECTED_PROVIDER_USER: &str = "selected-provider";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider { Deepseek, Kimi }

impl AiProvider {
    fn key(&self) -> &'static str { match self { Self::Deepseek => "deepseek", Self::Kimi => "kimi" } }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderStatus { pub selected_provider: AiProvider, pub deepseek: &'static str, pub kimi: &'static str }

pub(crate) fn credential_entry(provider: &AiProvider) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, provider.key()).map_err(|error| error.to_string())
}

fn selected_provider() -> AiProvider {
    keyring::Entry::new(KEYRING_SERVICE, SELECTED_PROVIDER_USER).ok()
        .and_then(|entry| entry.get_password().ok())
        .and_then(|value| match value.as_str() { "kimi" => Some(AiProvider::Kimi), "deepseek" => Some(AiProvider::Deepseek), _ => None })
        .unwrap_or(AiProvider::Deepseek)
}

#[tauri::command]
pub fn save_ai_credential(provider: AiProvider, secret: String) -> Result<&'static str, String> {
    if secret.is_empty() { return Err("密钥不能为空".into()); }
    credential_entry(&provider)?.set_password(&secret).map_err(|error| error.to_string())?;
    Ok("configured")
}

#[tauri::command]
pub fn clear_ai_credential(provider: AiProvider) -> Result<&'static str, String> {
    let entry = credential_entry(&provider)?;
    match entry.delete_credential() { Ok(()) | Err(keyring::Error::NoEntry) => Ok("not_configured"), Err(error) => Err(error.to_string()) }
}

#[tauri::command]
pub fn get_ai_provider_status() -> Result<AiProviderStatus, String> {
    let configured = |provider: AiProvider| credential_entry(&provider).map(|entry| entry.get_password().is_ok()).unwrap_or(false);
    Ok(AiProviderStatus { selected_provider: selected_provider(), deepseek: if configured(AiProvider::Deepseek) { "configured" } else { "not_configured" }, kimi: if configured(AiProvider::Kimi) { "configured" } else { "not_configured" } })
}

#[tauri::command]
pub fn set_ai_provider(provider: AiProvider) -> Result<AiProvider, String> {
    keyring::Entry::new(KEYRING_SERVICE, SELECTED_PROVIDER_USER).map_err(|error| error.to_string())?.set_password(provider.key()).map_err(|error| error.to_string())?;
    Ok(provider)
}

#[tauri::command(rename = "init_database")]
pub fn init_database(state: State<'_, Database>) -> Result<(), String> { let connection = state.0.lock().map_err(|e| e.to_string())?; initialize(&connection) }

#[tauri::command]
pub fn save_bazi_record(state: State<'_, Database>, mut record: BaziRecord) -> Result<BaziRecord, String> {
    let id = record.id.take().unwrap_or_else(|| format!("record-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let connection = state.0.lock().map_err(|e| e.to_string())?;
    initialize(&connection)?;
    connection.execute("INSERT OR REPLACE INTO bazi_records (id,name,gender,birth_year,birth_month,created_at,year_pillar,month_pillar,day_pillar,hour_pillar,non_ai_result,ai_status,ai_analysis,ai_overview,ai_error,ai_tasks) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)", params![id, record.name, record.gender, record.birth_year, record.birth_month, record.created_at, record.year_pillar, record.month_pillar, record.day_pillar, record.hour_pillar, record.non_ai_result, record.ai_status, record.ai_analysis, record.ai_overview, record.ai_error, record.ai_tasks]).map_err(|e| e.to_string())?;
    record.id = Some(id); Ok(record)
}

#[tauri::command]
pub fn list_bazi_records(state: State<'_, Database>) -> Result<Vec<BaziRecord>, String> {
    let connection = state.0.lock().map_err(|e| e.to_string())?;
    let mut statement = connection.prepare("SELECT id,name,gender,birth_year,birth_month,created_at,year_pillar,month_pillar,day_pillar,hour_pillar,non_ai_result,ai_status,ai_analysis,ai_overview,ai_error,ai_tasks FROM bazi_records ORDER BY rowid DESC").map_err(|e| e.to_string())?;
    let result = statement.query_map([], row_to_record).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string()); result
}

#[tauri::command]
pub fn get_bazi_record(state: State<'_, Database>, id: String) -> Result<Option<BaziRecord>, String> {
    let connection = state.0.lock().map_err(|e| e.to_string())?;
    connection.query_row("SELECT id,name,gender,birth_year,birth_month,created_at,year_pillar,month_pillar,day_pillar,hour_pillar,non_ai_result,ai_status,ai_analysis,ai_overview,ai_error,ai_tasks FROM bazi_records WHERE id = ?1", [id], row_to_record).optional().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_bazi_record(state: State<'_, Database>, id: String) -> Result<(), String> {
    let connection = state.0.lock().map_err(|e| e.to_string())?;
    // 先取该盘(性别+四柱)以便连缓存一起删
    let key: Option<(String, String, String, String, String)> = connection.query_row(
        "SELECT gender, year_pillar, month_pillar, day_pillar, hour_pillar FROM bazi_records WHERE id = ?1",
        [&id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).optional().map_err(|e| e.to_string())?;
    connection.execute("DELETE FROM bazi_records WHERE id = ?1", [&id]).map_err(|e| e.to_string())?;
    if let Some((gender, y, m, d, h)) = key {
        let _ = purge_chart_cache(&connection, &gender, &y, &m, &d, &h);
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStats { pub records: i64, pub cache_entries: i64, pub db_bytes: u64 }

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactResult { pub changed_records: usize }

/// 存量压缩：把旧版完整盘(含 120 流月+10 流年等 ~200KB)变成 ~3KB 的“本命要点+空占位”，
/// 客户端打开详情时会用确定性引擎即时重算，功能不受影响。
pub(crate) fn compact_records_in(connection: &rusqlite::Connection) -> Result<(usize, usize), String> {
    let mut statement = connection.prepare("SELECT id, non_ai_result FROM bazi_records").map_err(|e| e.to_string())?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))).map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    let mut changed = 0usize;
    let mut kept = 0usize;
    for (id, raw) in rows {
        let Some(raw) = raw else { kept += 1; continue; };
        let Ok(mut value) = serde_json::from_str::<Value>(&raw) else { kept += 1; continue; };
        let needs = match (value.get("greatFortunes"), value.get("annualFortunes"), value.get("monthlyFortunes")) {
            (Some(Value::Array(a)), Some(Value::Array(b)), Some(Value::Array(c0))) => !a.is_empty() || !b.is_empty() || !c0.is_empty(),
            _ => false,
        };
        if !needs { kept += 1; continue; }
        if let Some(obj) = value.as_object_mut() {
            obj.insert("greatFortunes".into(), Value::Array(Vec::new()));
            obj.insert("annualFortunes".into(), Value::Array(Vec::new()));
            obj.insert("monthlyFortunes".into(), Value::Array(Vec::new()));
            connection.execute("UPDATE bazi_records SET non_ai_result = ?1 WHERE id = ?2", params![value.to_string(), id]).map_err(|e| e.to_string())?;
            changed += 1;
        } else { kept += 1; }
    }
    Ok((changed, kept))
}

pub(crate) fn purge_chart_cache(connection: &rusqlite::Connection, gender: &str, y: &str, m: &str, d: &str, h: &str) -> Result<usize, String> {
    let pattern = format!("%|{}|{}|{}|{}|{}|%", gender, y, m, d, h);
    connection.execute("DELETE FROM ai_cache WHERE cache_key LIKE ?1", [pattern]).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_chart_cache(state: State<'_, Database>, gender: String, year_pillar: String, month_pillar: String, day_pillar: String, hour_pillar: String) -> Result<usize, String> {
    // 清空并全量重算 = 真删缓存：让同盘同任务不再命中，重新调用 AI
    let connection = state.0.lock().map_err(|e| e.to_string())?;
    purge_chart_cache(&connection, &gender, &year_pillar, &month_pillar, &day_pillar, &hour_pillar)
}

#[tauri::command]
pub fn get_storage_stats(state: State<'_, Database>) -> Result<StorageStats, String> {
    let connection = state.0.lock().map_err(|e| e.to_string())?;
    let records = connection.query_row("SELECT COUNT(*) FROM bazi_records", [], |row| row.get(0)).map_err(|e| e.to_string())?;
    let cache_entries = connection.query_row("SELECT COUNT(*) FROM ai_cache", [], |row| row.get(0)).map_err(|e| e.to_string())?;
    let dir = exe_data_dir()?;
    let db_bytes = std::fs::metadata(database_path(Path::new(&dir))).map(|meta| meta.len()).unwrap_or(0);
    Ok(StorageStats { records, cache_entries, db_bytes })
}

#[tauri::command]
pub async fn ai_self_test() -> Result<Value, String> {
    // 连通性自检：用一次最小请求验证所选服务的密钥是否可用(几乎零成本，不含推理)。
    let mut errors = Vec::new();
    for provider in provider_order(&selected_provider()) {
        let secret = match credential_entry(&provider)?.get_password() {
            Ok(secret) => secret,
            Err(_) => { errors.push(format!("{} 未配置密钥", provider.key())); continue; }
        };
        let endpoint = match provider { AiProvider::Deepseek => "https://api.deepseek.com/chat/completions", AiProvider::Kimi => "https://api.moonshot.cn/v1/chat/completions" };
        let model = match provider { AiProvider::Deepseek => "deepseek-chat", AiProvider::Kimi => "kimi-k2.6" };
        let request = serde_json::json!({ "model": model, "temperature": 0, "messages": [{ "role": "user", "content": "只回复两个字母：ok" }] });
        let started = std::time::Instant::now();
        let response = match reqwest::Client::new().post(endpoint).bearer_auth(&secret).json(&request).send().await {
            Ok(response) => response,
            Err(_) => { errors.push(format!("{} 网络失败", provider.key())); continue; }
        };
        let latency_ms = started.elapsed().as_millis();
        if !response.status().is_success() { errors.push(format!("{} HTTP {}", provider.key(), response.status())); continue; }
        let body: Value = match response.json().await { Ok(body) => body, Err(_) => { errors.push(format!("{} 响应解析失败", provider.key())); continue; } };
        let reply = body["choices"][0]["message"]["content"].as_str().unwrap_or("").trim().to_string();
        return Ok(serde_json::json!({ "ok": true, "provider": provider.key(), "model": model, "reply": reply, "latencyMs": latency_ms }));
    }
    Err(errors.join("；"))
}

#[tauri::command]
pub fn compact_records(state: State<'_, Database>) -> Result<CompactResult, String> {
    let connection = state.0.lock().map_err(|e| e.to_string())?;
    let (changed, _) = compact_records_in(&connection)?;
    Ok(CompactResult { changed_records: changed })
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTaskInput {
    pub task_id: String,
    #[serde(rename = "type")] pub task_type: String,
    pub year: Option<i32>, pub month: Option<i32>,
    pub annual: Option<Value>, pub monthly: Option<Value>, pub baseline: Option<Value>,
    pub guide: Option<Value>, // 行动改变/职业适配：喜用五行对应的资料
}

#[derive(Debug, Serialize)]
pub struct AiTaskOutput { pub task: AiTaskInput, pub status: String, pub analysis: Option<Value>, pub error: Option<String> }

pub(crate) fn provider_order(selected: &AiProvider) -> [AiProvider; 2] {
    match selected {
        AiProvider::Deepseek => [AiProvider::Deepseek, AiProvider::Kimi],
        AiProvider::Kimi => [AiProvider::Kimi, AiProvider::Deepseek],
    }
}

pub(crate) fn provider_model(provider: &AiProvider) -> &'static str {
    // deepseek-reasoner = 思考模式(链式推理)；reasoner 不支持 temperature 参数。
    match provider { AiProvider::Deepseek => "deepseek-reasoner", AiProvider::Kimi => "kimi-k2.6" }
}

pub(crate) fn provider_temperature(provider: &AiProvider) -> Option<i32> {
    match provider { AiProvider::Deepseek => None, AiProvider::Kimi => Some(1) }
}

fn now_text() -> String {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().to_string()).unwrap_or_else(|_| "0".into())
}

/// 确定性缓存键：同一 八字+性别+任务类型+年份+月份+出生年(年龄) + 模型 => 同一输出。
/// 同一命盘(不同人同名同盘)命中同一缓存，重复分析与断点续跑不再花钱。
pub(crate) fn cache_key(record: &BaziRecord, task: &AiTaskInput, model: &str) -> String {
    format!("v4|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}", model, record.gender,
        record.year_pillar, record.month_pillar, record.day_pillar, record.hour_pillar,
        task.task_type, task.year.unwrap_or(0), task.month.unwrap_or(0), record.birth_year)
}

pub(crate) fn read_cache(connection: &rusqlite::Connection, key: &str) -> Result<Option<String>, String> {
    connection.query_row("SELECT payload FROM ai_cache WHERE cache_key = ?1", [key], |row| row.get(0)).optional().map_err(|e| e.to_string())
}

pub(crate) fn write_cache(connection: &rusqlite::Connection, key: &str, payload: &str) -> Result<(), String> {
    connection.execute("INSERT OR REPLACE INTO ai_cache (cache_key, payload, created_at) VALUES (?1, ?2, ?3)", params![key, payload, now_text()]).map_err(|e| e.to_string())?;
    Ok(())
}

/// 只把 API 兼容字段(模型/消息/温度)发给厂商，避免自定义元数据被严格网关拒绝。
pub(crate) fn api_request_payload(payload: &Value, model: &str, temperature: Option<i32>) -> Value {
    let mut out = serde_json::json!({ "model": model, "messages": payload["messages"].clone() });
    if let Some(t) = temperature { out["temperature"] = t.into(); }
    out
}

/// reasoner 实测要点：输出上限要给足(否则全耗在推理上正文为空)，并提示思考从简。
pub(crate) fn apply_reasoner_settings(api_payload: &mut Value) {
    api_payload["max_tokens"] = 32768.into();
    let mut messages = Vec::new();
    messages.push(serde_json::json!({ "role": "system", "content": "请把思考压缩到最短：只做必要判断，直接输出符合要求的 JSON；不要在推理里写长篇草稿。" }));
    if let Some(existing) = api_payload["messages"].as_array() { messages.extend(existing.iter().cloned()); }
    api_payload["messages"] = Value::Array(messages);
}

fn pick_by_year(rows: &Value, year: i32) -> Value {
    rows.as_array().and_then(|arr| arr.iter().find(|row| row.get("year").and_then(|v| v.as_i64()).map(|v| v as i32) == Some(year)).cloned()).unwrap_or(Value::Null)
}

fn pick_by_year_month(rows: &Value, year: i32, month: i32) -> Value {
    rows.as_array().and_then(|arr| arr.iter().find(|row| row.get("year").and_then(|v| v.as_i64()).map(|v| v as i32) == Some(year) && row.get("month").and_then(|v| v.as_i64()).map(|v| v as i32) == Some(month)).cloned()).unwrap_or(Value::Null)
}

/// 把某运/年/月行内与该行有关的 relationshipDetails 压成可读命中串(供刑冲克害批注)。
pub(crate) fn summarize_hits(row: &Value, own_gan_zhi: &str) -> Vec<String> {
    let label: fn(&str) -> &'static str = |t: &str| match t {
        "sanHe" => "三合", "liuHe" => "六合", "chong" => "六冲", "xing" => "相刑",
        "hai" => "六害", "po" => "六破", "ke" => "相克", _ => "其它",
    };
    let mut out: Vec<String> = Vec::new();
    if let Some(details) = row.get("relationshipDetails").and_then(|v| v.as_array()) {
        for item in details {
            let tp = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            let sp = item.get("sourcePillar").and_then(|v| v.as_str()).unwrap_or("");
            let tg = item.get("targetPillar").and_then(|v| v.as_str()).unwrap_or("");
            let st = item.get("status").and_then(|v| v.as_str()).unwrap_or("");
            if sp == own_gan_zhi || tg == own_gan_zhi || (sp.is_empty() && tg.is_empty()) {
                let extra = match st { "half-combination" => "半合", "partial-punishment" => "半刑", "binding" => "", _ => "" };
                out.push(format!("{}({}{})", label(tp), if tg == own_gan_zhi { sp } else { tg }, extra));
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

fn pick_decade(rows: &Value, year: i32) -> Value {
    rows.as_array().and_then(|arr| arr.iter().find(|row| {
        let start = row.get("startYear").and_then(|v| v.as_i64()).map(|v| v as i32).unwrap_or(i32::MIN);
        let end = row.get("endYear").and_then(|v| v.as_i64()).map(|v| v as i32).unwrap_or(i32::MAX);
        start <= year && year <= end
    }).cloned()).unwrap_or(Value::Null)
}

pub(crate) fn final_ai_status(errors: &[String]) -> (&'static str, Option<String>) {
    ("failed", Some(if errors.is_empty() { "AI request failed".into() } else { errors.join("; ") }))
}

/// 只打包“本次任务需要的最小上下文”：本命要点 + 该年/该月/所处大运单行，
/// 不再把 120 条流月+10 条流年(约 200KB)整包发送(那是 token 成本的第一大元凶)。
pub fn build_ai_request_payload(record: &BaziRecord, task: &AiTaskInput) -> Result<Value, String> {
    let parsed: Value = record.non_ai_result.as_deref().map(serde_json::from_str).transpose().map_err(|e| e.to_string())?.unwrap_or(Value::Null);
    let val = |key: &str| parsed.get(key).cloned().unwrap_or(Value::Null);
    let natal = serde_json::json!({
        "gender": record.gender,
        "birthYear": record.birth_year,
        "pillars": { "year": record.year_pillar, "month": record.month_pillar, "day": record.day_pillar, "hour": record.hour_pillar },
        "solarDate": val("solarDate"), "lunarDate": val("lunarDate"), "zodiac": val("zodiac"), "dayMaster": val("dayMaster"),
        "fortuneStart": val("fortuneStart"),
        "elements": val("elements"), "elementRatio": val("elementRatio"),
        "hiddenStems": val("hiddenStems"), "tenGods": val("tenGods"), "tenGodDetails": val("tenGodDetails"),
        "naYin": val("naYin"), "twelveLongevity": val("twelveLongevity"),
        "shenSha": val("shenSha"), "relationships": val("relationships"),
    });
    // 行动改变与职业适配(喜用五行知识库)：附加 baseline 摘要与 guide 资料
    if task.task_type == "adjustment" {
        if let Some(guide) = task.guide.as_ref() {
            let guide_text = serde_json::to_string(guide).unwrap_or_default();
            let baseline_text = task.baseline.as_ref().map(|v| v.to_string()).unwrap_or_else(|| "（暂无本命结论）".into());
            let body = serde_json::json!({
                "when": "后天调整与职业适配".to_string(),
                "baselineSummary": baseline_text,
                "guide": guide_text,
            });
            let content = format!("你是资深子平命理师。根据【本命结论】的喜用五行与下方【资料库】中对应五行的后天调整/职业知识，输出该命局的【后天调整】与【事业职业适配】建议(长文，尽量贴合资料，不要另造体系)。禁止输出/* */注释、HTML注释或代码块标记，只给最终正文。JSON schema：{{\"explanation\":长文}}，explanation 用【后天调整】【事业适配】【健康注意】分段。\n\n# 本命结论\n{}\n\n# 资料库(喜用{})\n{}", baseline_text, guide.get("element").and_then(|e| e.as_str()).unwrap_or(""), guide_text);
            return Ok(serde_json::json!({
                "model": "deepseek-reasoner", "promptVersion": "ctx-v4", "thinking": true,
                "taskId": task.task_id, "type": task.task_type, "year": task.year, "month": task.month,
                "nonAiResult": body,
                "messages": [{ "role": "user", "content": content }]
            }));
        }
    }
    let mut scope = serde_json::json!({});
    if let Some(y) = task.year {
        scope["age"] = (y - record.birth_year).into();
        match task.task_type.as_str() {
            // 大运任务：只给该大运段 + 年龄(不掺入年度/月份行)
            "decade" => {
                let decade = pick_decade(&parsed["greatFortunes"], y);
                if decade != Value::Null {
                    scope["decade"] = decade.clone();
                    let gz = decade.get("ganZhi").and_then(|v| v.as_str()).unwrap_or("");
                    if !gz.is_empty() { scope["decadeHits"] = serde_json::to_value(summarize_hits(&decade, gz)).unwrap_or(Value::Null); }
                }
            }
            _ => {
                let annual = pick_by_year(&parsed["annualFortunes"], y);
                if annual != Value::Null {
                    scope["annual"] = annual.clone();
                    let gz = annual.get("ganZhi").and_then(|v| v.as_str()).unwrap_or("");
                    if !gz.is_empty() { scope["annualHits"] = serde_json::to_value(summarize_hits(&annual, gz)).unwrap_or(Value::Null); }
                }
                let decade = pick_decade(&parsed["greatFortunes"], y);
                if decade != Value::Null {
                    scope["decade"] = decade.clone();
                    let gz = decade.get("ganZhi").and_then(|v| v.as_str()).unwrap_or("");
                    if !gz.is_empty() { scope["decadeHits"] = serde_json::to_value(summarize_hits(&decade, gz)).unwrap_or(Value::Null); }
                }
                if let Some(m) = task.month {
                    let mut monthly = pick_by_year_month(&parsed["monthlyFortunes"], y, m);
                    if monthly == Value::Null {
                        // 滚动十二个月可能越过引擎预生成的节月序列：使用客户端随任务带来的月度行
                        if let Some(inline) = task.monthly.as_ref() {
                            if inline.get("ganZhi").and_then(|v| v.as_str()).is_some() { monthly = inline.clone(); }
                        }
                    }
                    if monthly != Value::Null {
                        scope["monthly"] = monthly.clone();
                        let gz = monthly.get("ganZhi").and_then(|v| v.as_str()).unwrap_or("");
                        if !gz.is_empty() { scope["monthlyHits"] = serde_json::to_value(summarize_hits(&monthly, gz)).unwrap_or(Value::Null); }
                    }
                }
            }
        }
    }
    let when = match task.task_type.as_str() {
        "decade" => format!("所处大运(含 {} 年)", task.year.unwrap_or(0)),
        "baseline" | "overview" | "synthesis" => "本命/全局".to_string(),
        _ => match (task.year, task.month) {
            (Some(y), Some(m)) => format!("{y}年{m}月"),
            (Some(y), None) => format!("{y}年"),
            _ => "本命/全局".to_string(),
        },
    };
    let age_seg = task.year.map(|y| format!("(年龄约 {})", y - record.birth_year)).unwrap_or_default();
let is_scope = matches!(task.task_type.as_str(), "annual" | "monthly" | "decade");
    let prompt = if is_scope {
        format!(
            "你是资深子平命理师，仅分析时段运势。严格依据下方【事实数据(JSON)】作答，禁止自行推算干支、十神、五行或关系。禁止输出/* */注释、HTML注释或任何代码块/围栏标记，只给最终正文。当前分析目标：{when}{age_seg}。本命的身强身弱/格局/喜忌已在 natal 结论中单独确定，你不要再输出强弱/格局/喜忌判断。用 JSON(仅 JSON)返回，schema：{{\"title\":\"两行式标题(可选)\",\"explanation\":长文}}。title 需有古风韵味并只能引用下列古籍原文/口诀(标注出处，禁止自创伪古文)：六合(《三命通会》六合歌)：子与丑合、寅与亥合、卯与戌合、辰与酉合、巳与申合、午与未合；六冲(《渊海子平》冲诀，地支七位为冲)：子午、丑未、寅申、卯酉、辰戌、巳亥相冲；三刑(《三命通会·论三刑》)：子刑卯卯刑子为无礼之刑，寅刑巳巳刑申申刑寅为恃势之刑，丑刑戌戌刑未未刑丑为无恩之刑，辰午酉亥自刑；六害(穿害口诀)：子未害丑午害寅巳害卯辰害申亥害酉戌害；六破(破口诀)：子酉破丑辰破寅亥破卯午破巳申破未戌破。若无对应原文则标题用干支+四字直书(如：卯戌六合·和合之象)，不得编造引文。explanation 按【健康】【事业】【财运】【爱情】分段展开；若 scope 提供 annualHits/monthlyHits/decadeHits 关系命中，末尾加【刑冲克害批注】。批注必须是编号要点，每行格式：数字. 关系（干支实例说明）：一句影响，例如：1. 三合（巳酉丑半合）：…；2. 六害（丙戌）：…。每条一句话，把 合/冲/刑/害/破/克 的对象与含义写清楚；无命中则省略该段。各主题全文只出现一次，勿先短句后长文重复。"
        )
    } else {
        format!(
            "你是资深子平命理师。严格依据下方【事实数据(JSON)】中的确定性命理数据作答，禁止自行推算干支、十神、五行、藏干或干支关系。禁止输出/* */注释、HTML注释或任何代码块/围栏标记，只给最终正文。当前分析目标：本命{age_seg}。用 JSON(仅 JSON)返回，schema：{{\"pattern\":格局,\"strength\":身强/身弱/中和,\"usefulElements\":[喜用],\"avoidElements\":[忌用],\"explanation\":长文}}。explanation 从【身强身弱与喜忌】开始，依次【健康】【事业】【财运】【爱情】，以【总评/行为建议】收尾；各主题全文只出现一次，禁止在 JSON 顶层重复 overall/health/career/wealth/love/notice 等字段，也不要先给短句摘要再写长文。"
        )
    };
    // 关键：把“事实数据 JSON”直接嵌入消息正文 —— 模型只能看到 messages，
    // 顶层字段(如 nonAiResult)对模型不可见(此前因此返回“未提供结构化输入”)。
    let context = serde_json::json!({ "natal": natal, "scope": scope });
    let context_text = serde_json::to_string(&context).unwrap_or_else(|_| "{}".into());
    // 时段分析必须沿用本命已定的强弱/喜忌结论(锚点)，防止模型自行推断或跑偏
    let natal_note = if is_scope {
        task.baseline.as_ref().and_then(|b| b.get("summary")).and_then(|s| s.as_str())
            .map(|s| format!("\n# 本命结论(已定，必须沿用，不得推翻或重算)\n{s}\n")).unwrap_or_default()
    } else { String::new() };
    let content = format!("{prompt}{natal_note}\n\n# 事实数据(JSON，务必只依据此数据，禁止自行推算干支/十神/五行/藏干或关系)\n{context_text}");
    Ok(serde_json::json!({
        "model": "deepseek-reasoner", "promptVersion": "ctx-v2", "thinking": true,
        "taskId": task.task_id, "type": task.task_type, "year": task.year, "month": task.month,
        "nonAiResult": context,
        "messages": [{ "role": "user", "content": content }]
    }))
}

#[tauri::command]
pub async fn run_ai_task(state: State<'_, Database>, record: BaziRecord, task: AiTaskInput) -> Result<AiTaskOutput, String> {
    let mut errors = Vec::new();
    for provider in provider_order(&selected_provider()) {
        let model = provider_model(&provider);
        let cache = cache_key(&record, &task, model);
        // 命中缓存：同盘同任务不再重复调用 API(成本优化)
        {
            let connection = state.0.lock().map_err(|e| e.to_string())?;
            if let Ok(Some(payload)) = read_cache(&connection, &cache) {
                if let Ok(analysis) = serde_json::from_str::<Value>(&payload) {
                    return Ok(AiTaskOutput { task, status: "completed".into(), analysis: Some(analysis), error: None });
                }
            }
        }
        let secret = match credential_entry(&provider)?.get_password() {
            Ok(secret) => secret,
            Err(_) => { errors.push(format!("{} credential unavailable", provider.key())); continue; }
        };
        let endpoint = match provider { AiProvider::Deepseek => "https://api.deepseek.com/chat/completions", AiProvider::Kimi => "https://api.moonshot.cn/v1/chat/completions" };
        let payload = build_ai_request_payload(&record, &task)?;
        let mut api_payload = api_request_payload(&payload, model, provider_temperature(&provider));
        if model == "deepseek-reasoner" { apply_reasoner_settings(&mut api_payload); } // 高上限+思考从简，避免正文为空
        // 传输层抗抖：429/5xx/网络错误重试一次(同 provider)，降低单任务失败率
        let mut transport_ok = false;
        let mut body: Value = Value::Null;
        let mut request_failed = String::new();
        for attempt in 0..2u8 {
            match reqwest::Client::new().post(endpoint).bearer_auth(&secret).json(&api_payload).send().await {
                Ok(response) if response.status().is_success() => {
                    match response.json::<Value>().await {
                        Ok(parsed) => { body = parsed; transport_ok = true; break; }
                        Err(_) => { request_failed = "invalid response".into(); break; }
                    }
                }
                Ok(response) => {
                    let code = response.status().as_u16();
                    if attempt == 0 && (code == 429 || code >= 500) { continue; }
                    request_failed = format!("HTTP {code}");
                    break;
                }
                Err(_) => {
                    if attempt == 0 { continue; }
                    request_failed = "network failure".into();
                    break;
                }
            }
        }
        if !transport_ok { errors.push(request_failed); continue; }
        let content = match body["choices"][0]["message"]["content"].as_str() { Some(content) => content, None => { errors.push("invalid response".into()); continue; } };
        let content = content.trim().trim_start_matches("```json").trim_end_matches("```").trim();
        match serde_json::from_str::<Value>(content) {
            Ok(analysis) => {
                if let Ok(connection) = state.0.lock() {
                    let _ = write_cache(&connection, &cache, &analysis.to_string());
                }
                return Ok(AiTaskOutput { task, status: "completed".into(), analysis: Some(analysis), error: None });
            }
            Err(_) => errors.push("invalid response".into()),
        }
    }
    let (status, error) = final_ai_status(&errors);
    Ok(AiTaskOutput { task, status: status.into(), analysis: None, error })
}
}

/// 数据目录 = exe 同目录下的 data(全相对路径，绿色便携：整个文件夹拷贝即可迁移数据)
fn exe_data_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or_else(|| "executable has no parent directory".to_string())?;
    Ok(dir.join("data"))
}

fn database_path(base: &Path) -> PathBuf {
    base.join("bazi_records.sqlite3")
}

fn open_database(data_dir: &Path) -> Result<Connection, Box<dyn std::error::Error>> {
    // 不做旧库迁移：新库保持干净，避免把旧测试数据带进来
    std::fs::create_dir_all(data_dir)?;
    let database = database_path(data_dir);
    let connection = Connection::open(&database)?;
    initialize(&connection).map_err(std::io::Error::other)?;
    Ok(connection)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 桌面：exe 同目录 data(绿色便携)；移动端(iOS/iPadOS/Android)：系统沙盒数据目录
            let data_dir = if cfg!(any(target_os = "ios", target_os = "android")) {
                app.path().app_data_dir().map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?
            } else {
                exe_data_dir().map_err(|e| Box::<dyn std::error::Error>::from(e))?
            };
            let connection = open_database(Path::new(&data_dir)).map_err(|e| Box::<dyn std::error::Error>::from(e))?;
            app.manage(Database(Mutex::new(connection)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![commands::init_database, commands::save_bazi_record, commands::list_bazi_records, commands::get_bazi_record, commands::delete_bazi_record, commands::clear_chart_cache, commands::get_storage_stats, commands::compact_records, commands::ai_self_test, commands::save_ai_credential, commands::clear_ai_credential, commands::get_ai_provider_status, commands::set_ai_provider, commands::run_ai_task])
        .run(tauri::generate_context!()).expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn database_path_is_under_the_given_data_directory() {
        let data = Path::new("/opt/app/data");
        assert_eq!(database_path(data), Path::new("/opt/app/data/bazi_records.sqlite3"));
    }

    #[test]
    fn sqlite_round_trip_preserves_raw_fields() {
        let connection = Connection::open_in_memory().unwrap(); initialize(&connection).unwrap();
        let non_ai = serde_json::json!({
            "pillars": { "year": "甲子", "month": "丙寅", "day": "庚午", "hour": "壬午" },
            "lunarDate": "甲子年正月初一", "solarDate": "1984-02-06", "zodiac": "鼠",
            "elements": { "木": 1, "火": 2, "土": 0, "金": 1, "水": 0 },
            "elementRatio": { "木": 0.25, "火": 0.5, "土": 0.0, "金": 0.25, "水": 0.0 },
            "hiddenStems": [["癸"], ["甲", "丙", "戊"], ["丁", "己"], ["壬", "甲"]],
            "tenGods": ["伤官", "偏财", "日主", "食神"], "naYin": ["海中金", "炉中火", "路旁土", "大海水"],
            "dayMaster": "庚", "fortuneStart": "1987-01-01", "forecastRange": [2025, 2026],
            "greatFortunes": [
                { "ganZhi": "丁卯", "startYear": 1987, "endYear": 1996 },
                { "ganZhi": "辛未", "startYear": 2017, "endYear": 2026 }
            ],
            "twelveLongevity": ["沐浴", "绝", "死", "长生"],
            "shenSha": { "auspicious": ["天德"], "inauspicious": ["岁破"] }
        }).to_string();
        connection.execute("INSERT INTO bazi_records VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)", params!["id", "名", "female", 2000, 2, "2025-01-01T00:00:00.000Z", "甲子", "乙丑", "丙寅", "丁卯", non_ai, "not_started", Option::<String>::None, Option::<String>::None, Option::<String>::None, Option::<String>::None]).unwrap();
        let record = connection.query_row("SELECT id,name,gender,birth_year,birth_month,created_at,year_pillar,month_pillar,day_pillar,hour_pillar,non_ai_result,ai_status,ai_analysis,ai_overview,ai_error,ai_tasks FROM bazi_records", [], row_to_record).unwrap();
        assert_eq!(record.name, "名"); assert_eq!(record.hour_pillar, "丁卯"); assert_eq!(record.birth_month, 2);
        assert_eq!(record.non_ai_result.as_deref(), Some(non_ai.as_str()));
        assert_eq!(record.created_at, "2025-01-01T00:00:00.000Z");
    }

    #[test]
    fn ai_payload_keeps_structured_facts_and_stable_task_fields() {
        let record = BaziRecord { id: Some("r1".into()), name: "名".into(), gender: "male".into(), birth_year: 1984, birth_month: 2, created_at: "2025-01-01".into(), year_pillar: "甲子".into(), month_pillar: "丙寅".into(), day_pillar: "庚午".into(), hour_pillar: "壬午".into(), non_ai_result: Some(r#"{"zodiac":"鼠"}"#.into()), ai_status: "pending".into(), ai_analysis: None, ai_overview: None, ai_error: None, ai_tasks: None };
        let task = commands::AiTaskInput { task_id: "task-03".into(), task_type: "annual".into(), year: Some(2025), month: None, annual: None, monthly: None, baseline: None, guide: None };
        let payload = commands::build_ai_request_payload(&record, &task).unwrap();
        assert_eq!(payload["taskId"], "task-03");
        assert_eq!(payload["type"], "annual");
        assert_eq!(payload["year"], 2025);
        // 结构事实保留在本命要点中(compact 结构)
        assert_eq!(payload["nonAiResult"]["natal"]["zodiac"], "鼠");
        assert_eq!(payload["nonAiResult"]["natal"]["pillars"]["day"], "庚午");
        assert!(payload["nonAiResult"]["natal"].get("annualFortunes").is_none());
        // 关键：事实 JSON 必须嵌入消息正文，否则模型看不到数据(历史 bug)
        let content = payload["messages"][0]["content"].as_str().unwrap();
        assert!(content.contains("事实数据"));
        assert!(content.contains("\"zodiac\":\"鼠\"") || content.contains("zodiac"));
    }

    #[test]
    fn provider_order_prefers_selected_service_and_falls_back_to_the_other() {
        assert_eq!(commands::provider_order(&commands::AiProvider::Deepseek), [commands::AiProvider::Deepseek, commands::AiProvider::Kimi]);
        assert_eq!(commands::provider_order(&commands::AiProvider::Kimi), [commands::AiProvider::Kimi, commands::AiProvider::Deepseek]);
    }

    #[test]
    fn provider_models_match_current_service_api() {
        assert_eq!(commands::provider_model(&commands::AiProvider::Deepseek), "deepseek-reasoner");
        assert_eq!(commands::provider_model(&commands::AiProvider::Kimi), "kimi-k2.6");
        assert_eq!(commands::provider_temperature(&commands::AiProvider::Deepseek), None);
        assert_eq!(commands::provider_temperature(&commands::AiProvider::Kimi), Some(1));
    }

    #[test]
    fn compact_payload_drops_forecast_arrays_but_keeps_natal_facts() {
        let big = serde_json::json!({
            "zodiac": "鼠", "dayMaster": "庚",
            "annualFortunes": [{ "year": 2025, "ganZhi": "乙巳", "tenGod": "x" }],
            "monthlyFortunes": [{ "year": 2025, "month": 5, "ganZhi": "壬午" }],
            "greatFortunes": [
                { "ganZhi": "丁卯", "startYear": 1987, "endYear": 1996 },
                { "ganZhi": "辛未", "startYear": 2017, "endYear": 2026 }
            ]
        });
        let record = BaziRecord { id: Some("r1".into()), name: "名".into(), gender: "male".into(), birth_year: 1984, birth_month: 2, created_at: "2025-01-01".into(), year_pillar: "甲子".into(), month_pillar: "丙寅".into(), day_pillar: "庚午".into(), hour_pillar: "壬午".into(), non_ai_result: Some(big.to_string()), ai_status: "pending".into(), ai_analysis: None, ai_overview: None, ai_error: None, ai_tasks: None };
        let task = commands::AiTaskInput { task_id: "task-03".into(), task_type: "annual".into(), year: Some(2025), month: None, annual: None, monthly: None, baseline: None, guide: None };
        let payload = commands::build_ai_request_payload(&record, &task).unwrap();
        assert_eq!(payload["nonAiResult"]["natal"]["zodiac"], "鼠");
        assert_eq!(payload["nonAiResult"]["natal"]["dayMaster"], "庚");
        // 整包流年/流月数组不再进入请求体
        assert!(payload["nonAiResult"]["natal"].get("annualFortunes").is_none());
        assert!(payload["nonAiResult"]["natal"].get("monthlyFortunes").is_none());
        let scope = &payload["nonAiResult"]["scope"];
        assert_eq!(scope["annual"]["ganZhi"], "乙巳");
        assert_eq!(scope["decade"]["ganZhi"], "辛未");
        assert_eq!(scope["age"], 41);
        assert!(serde_json::to_string(&payload).unwrap().len() < 4000);
    }

    #[test]
    fn decade_payload_only_carries_decade_scope() {
        let big = serde_json::json!({
            "annualFortunes": [{ "year": 2025, "ganZhi": "乙巳" }],
            "greatFortunes": [{ "ganZhi": "辛未", "startYear": 2017, "endYear": 2026 }]
        });
        let record = BaziRecord { id: Some("r1".into()), name: "名".into(), gender: "male".into(), birth_year: 1984, birth_month: 2, created_at: "2025-01-01".into(), year_pillar: "甲子".into(), month_pillar: "丙寅".into(), day_pillar: "庚午".into(), hour_pillar: "壬午".into(), non_ai_result: Some(big.to_string()), ai_status: "pending".into(), ai_analysis: None, ai_overview: None, ai_error: None, ai_tasks: None };
        let task = commands::AiTaskInput { task_id: "task-26".into(), task_type: "decade".into(), year: Some(2017), month: None, annual: None, monthly: None, baseline: None, guide: None };
        let payload = commands::build_ai_request_payload(&record, &task).unwrap();
        let scope = &payload["nonAiResult"]["scope"];
        assert_eq!(scope["decade"]["ganZhi"], "辛未");
        assert_eq!(scope["age"], 33); // 2017-1984
        assert!(scope.get("annual").is_none()); // 大运任务不带年度行
        assert!(scope.get("monthly").is_none());
    }

    #[test]
    fn apply_reasoner_settings_raises_cap_and_adds_system_hint() {
        let mut api = serde_json::json!({ "model": "deepseek-reasoner", "messages": [{ "role": "user", "content": "x" }] });
        commands::apply_reasoner_settings(&mut api);
        assert_eq!(api["max_tokens"], 32768);
        let messages = api["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        assert!(messages[0]["content"].as_str().unwrap().contains("思考压缩"));
    }

    #[test]
    fn api_request_payload_sends_only_api_compatible_fields() {
        let payload = serde_json::json!({ "model": "deepseek-reasoner", "taskId": "t1", "type": "annual", "year": 2027, "nonAiResult": { "x": 1 }, "messages": [{ "role": "user", "content": "hi" }] });
        let api = commands::api_request_payload(&payload, "deepseek-reasoner", None);
        assert_eq!(api["model"], "deepseek-reasoner");
        assert!(api.get("taskId").is_none());
        assert!(api.get("nonAiResult").is_none());
        assert!(api.get("temperature").is_none()); // reasoner 不发送 temperature
        let warm = commands::api_request_payload(&payload, "kimi-k2.6", Some(1));
        assert_eq!(warm["temperature"], 1);
        assert_eq!(warm["messages"][0]["role"], "user");
    }

    #[test]
    fn summarize_hits_only_keeps_relations_of_the_own_gan_zhi() {
        let row = serde_json::json!({
            "ganZhi": "乙巳",
            "relationshipDetails": [
                { "type": "chong", "sourcePillar": "乙巳", "targetPillar": "辛亥", "status": "complete" },
                { "type": "liuHe", "sourcePillar": "丙寅", "targetPillar": "乙巳", "status": "binding" },
                { "type": "xing", "sourcePillar": "壬午", "targetPillar": "丁丑", "status": "partial-punishment" }
            ]
        });
        let hits = commands::summarize_hits(&row, "乙巳");
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().any(|h| h == "六合(丙寅)"));
        assert!(hits.iter().any(|h| h == "六冲(辛亥)"));
        assert!(!hits.iter().any(|h| h.contains("壬午")));
    }

    #[test]
    fn ai_cache_key_is_deterministic_and_scope_sensitive() {
        let record = BaziRecord { id: Some("r1".into()), name: "名".into(), gender: "male".into(), birth_year: 1984, birth_month: 2, created_at: "2025-01-01".into(), year_pillar: "甲子".into(), month_pillar: "丙寅".into(), day_pillar: "庚午".into(), hour_pillar: "壬午".into(), non_ai_result: None, ai_status: "pending".into(), ai_analysis: None, ai_overview: None, ai_error: None, ai_tasks: None };
        let mk = |y: Option<i32>, m: Option<i32>| commands::AiTaskInput { task_id: "t".into(), task_type: "monthly".into(), year: y, month: m, annual: None, monthly: None, baseline: None, guide: None };
        let k1 = commands::cache_key(&record, &mk(Some(2027), Some(5)), "deepseek-reasoner");
        let k2 = commands::cache_key(&record, &mk(Some(2027), Some(5)), "deepseek-reasoner");
        let k3 = commands::cache_key(&record, &mk(Some(2027), Some(6)), "deepseek-reasoner");
        let k4 = commands::cache_key(&record, &mk(Some(2027), Some(5)), "kimi-k2.6");
        assert_eq!(k1, k2);
        assert_ne!(k1, k3); // 月份不同 → 不同缓存
        assert_ne!(k1, k4); // 模型不同 → 不同缓存
    }

    #[test]
    fn ai_cache_round_trip_in_sqlite() {
        let connection = Connection::open_in_memory().unwrap(); initialize(&connection).unwrap();
        commands::write_cache(&connection, "key-a", r#"{"x":1}"#).unwrap();
        assert_eq!(commands::read_cache(&connection, "key-a").unwrap().as_deref(), Some(r#"{"x":1}"#));
        assert!(commands::read_cache(&connection, "missing").unwrap().is_none());
    }

    #[test]
    fn purge_chart_cache_removes_only_the_matching_chart() {
        let connection = Connection::open_in_memory().unwrap(); initialize(&connection).unwrap();
        commands::write_cache(&connection, "v4|deepseek-reasoner|male|甲子|丙寅|戊辰|庚申|annual|2026|0|1984", "{}").unwrap();
        commands::write_cache(&connection, "v4|deepseek-reasoner|male|甲子|丙寅|戊辰|庚申|monthly|2026|5|1984", "{}").unwrap();
        commands::write_cache(&connection, "v4|deepseek-reasoner|female|乙丑|丁卯|己巳|辛未|annual|2026|0|1985", "{}").unwrap();
        let removed = commands::purge_chart_cache(&connection, "male", "甲子", "丙寅", "戊辰", "庚申").unwrap();
        assert_eq!(removed, 2);
        let left: i64 = connection.query_row("SELECT COUNT(*) FROM ai_cache", [], |row| row.get(0)).unwrap();
        assert_eq!(left, 1); // 只删对应八字，其他命盘缓存保留
    }

    #[test]
    fn compact_records_in_slims_legacy_full_rows_only() {
        let connection = Connection::open_in_memory().unwrap(); initialize(&connection).unwrap();
        let full = serde_json::json!({
            "zodiac": "鼠", "dayMaster": "庚",
            "greatFortunes": [{ "ganZhi": "丁卯", "startYear": 1987, "endYear": 1996 }],
            "annualFortunes": [{ "year": 2025, "ganZhi": "乙巳" }],
            "monthlyFortunes": [{ "year": 2025, "month": 5, "ganZhi": "壬午" }]
        }).to_string();
        let slim = serde_json::json!({ "zodiac": "牛", "dayMaster": "辛", "greatFortunes": [], "annualFortunes": [], "monthlyFortunes": [] }).to_string();
        connection.execute("INSERT INTO bazi_records VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)", params!["a", "甲", "male", 1984, 2, "2025-01-01T00:00:00.000Z", "甲子", "丙寅", "庚午", "壬午", full, "completed", Option::<String>::None, Option::<String>::None, Option::<String>::None, Option::<String>::None]).unwrap();
        connection.execute("INSERT INTO bazi_records VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)", params!["b", "乙", "female", 2000, 2, "2025-01-01T00:00:00.000Z", "甲子", "乙丑", "丙寅", "丁卯", slim, "completed", Option::<String>::None, Option::<String>::None, Option::<String>::None, Option::<String>::None]).unwrap();
        let (changed, kept) = commands::compact_records_in(&connection).unwrap();
        assert_eq!(changed, 1);
        assert_eq!(kept, 1);
        let raw: String = connection.query_row("SELECT non_ai_result FROM bazi_records WHERE id='a'", [], |row| row.get(0)).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["greatFortunes"].as_array().unwrap().len(), 0);
        assert_eq!(parsed["zodiac"], "鼠");
    }
}
