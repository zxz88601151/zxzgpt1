// 执行许可（P0-4）：`exec` 类操作默认 ask，授权在 Rust 侧记账。
//
// 为什么闸门必须在这里，而不是在前端：
// 前端能做的是「弹个框问一下」，那是体验。真正的安全属性是「没有用户批准，
// 子进程不会起来」。只要这个判断留在 JS 里，任何能执行 JS 的路径（devtools、
// 前端 bug、将来接进来的第三方脚本）都能把它跳过。所以判定放在 IPC 后面：
// 未经批准的 argv 到这里直接被拒，前端无法自行提升权限。
//
// 授权粒度是「命令 + 子命令」（见 scope_of），不是完整 argv：
// 白名单已经限定了参数只能是安全的测试过滤词，所以「npm test」批一次就够，
// 不该因为模型多带了一个 `src/lib/tools.test.ts` 就再问一遍。
//
// 授权**不做持久化**：进程重启、会话关闭即失效。理由很直接——一条命令的批准
// 是一次具体的人类意图（"我同意现在跑这个"），把它写成磁盘上的长期通行证，
// 等于把一次性同意变成永久授权，而用户不会记得自己三个月前批过什么。

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::runx;

/// 一条授权。作用域是规范化后的命令前缀，例如 `["npm", "test"]`。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Grant {
    pub scope: Vec<String>,
    /// 还能用几次；`None` = 本会话内不限次（用户选了「本会话都允许」）
    pub uses_left: Option<u32>,
    /// 给人看的说明，审计与界面都用它
    pub label: String,
}

/// 判定结果。`Ask` 带上 scope，前端据此知道要给用户批什么。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Decision {
    Allow,
    Ask { scope: Vec<String>, label: String },
    Deny { reason: String },
}

fn store() -> &'static Mutex<HashMap<String, Vec<Grant>>> {
    static GRANTS: OnceLock<Mutex<HashMap<String, Vec<Grant>>>> = OnceLock::new();
    GRANTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 锁中毒时也要能继续工作：这里的数据是「谁被批准了什么」，
/// 一个 panic 的持锁者不该让整个执行通道永久不可用（拒绝服务并不是安全）。
fn lock() -> std::sync::MutexGuard<'static, HashMap<String, Vec<Grant>>> {
    store().lock().unwrap_or_else(|e| e.into_inner())
}

/// 把 argv 收敛成授权粒度：命令 + 子命令。
///
/// 只处理白名单里真实存在的形状（`is_allowed` 已经在前面把其余形状拒掉了），
/// 所以这里不需要再防守非法输入，只需要不漏算。
pub fn scope_of(argv: &[String]) -> Vec<String> {
    let Some(first) = argv.first() else {
        return Vec::new();
    };
    let cmd = runx::normalize_cmd(first);
    let rest = &argv[1..];
    let low = |i: usize| rest.get(i).map(|s| s.to_ascii_lowercase());
    match cmd.as_str() {
        // npm run build / npm run lint 是两条不同的脚本，必须分开授权
        "npm" if low(0).as_deref() == Some("run") => match low(1) {
            Some(sub) => vec![cmd, "run".into(), sub],
            None => vec![cmd, "run".into()],
        },
        "npm" => match low(0) {
            Some(sub) => vec![cmd, sub],
            None => vec![cmd],
        },
        // npx vitest run：三个词才定位到「跑测试」
        "npx" => {
            let mut v = vec![cmd];
            if let Some(a) = low(0) {
                v.push(a);
            }
            if let Some(b) = low(1) {
                v.push(b);
            }
            v
        }
        "git" => match low(0) {
            Some(sub) => vec![cmd, sub],
            None => vec![cmd],
        },
        // node 只放行 --version，带上它才不至于把整条 node 都授权出去
        "node" => match low(0) {
            Some(flag) => vec![cmd, flag],
            None => vec![cmd],
        },
        _ => vec![cmd],
    }
}

/// 查表并消耗一次授权。exec 与 MCP 共用同一张表、同一套消耗语义：
/// 一次性授权用完即清、会话级授权不限次、不同 scope 绝不外溢。
fn consume_scope(session_id: &str, scope: &[String]) -> bool {
    let mut map = lock();
    let mut allowed = false;
    if let Some(list) = map.get_mut(session_id) {
        if let Some(g) = list
            .iter_mut()
            .find(|g| g.scope.as_slice() == scope && g.uses_left != Some(0))
        {
            if let Some(n) = g.uses_left {
                g.uses_left = Some(n.saturating_sub(1));
            }
            allowed = true;
        }
        // 用完的一次性授权立刻清掉，别留在表里做"看起来还有"的假象
        list.retain(|g| g.uses_left != Some(0));
        if list.is_empty() {
            map.remove(session_id);
        }
    }
    allowed
}

/// 判定一次执行请求。
///
/// 顺序很重要：先过白名单，再看授权。白名单不过的命令**直接 Deny**，
/// 连「问用户」的机会都不给——否则界面会为 `npm install` 弹一个确认框，
/// 用户点「允许」之后才发现白名单还是拒的，那只是把拒绝包装成了骚扰。
pub fn decide(session_id: &str, argv: &[String]) -> Decision {
    if let Err(reason) = runx::is_allowed(argv) {
        return Decision::Deny { reason };
    }
    let scope = scope_of(argv);
    if scope.is_empty() {
        return Decision::Deny { reason: "命令为空".into() };
    }
    if consume_scope(session_id, &scope) {
        return Decision::Allow;
    }
    Decision::Ask { label: scope.join(" "), scope }
}

// ---------------------------------------------------------------------------
// MCP 工具授权（ADR 0004）
//
// MCP 不走 `runx::is_allowed`（那是命令白名单，工具名不是命令），但**共用**
// `perms` 授权表与 `grant` IPC：scope = ["mcp", server, tool]，与前端
// `src/lib/toolpolicy.ts::mcpScope` 逐字镜像。判定仍在 IPC 后面的 Rust 侧，
// 前端弹框只是体验；任何能执行 JS 的路径都跳不过这道闸门。
// ---------------------------------------------------------------------------

pub fn mcp_scope(server: &str, tool: &str) -> Vec<String> {
    vec!["mcp".into(), server.to_ascii_lowercase(), tool.to_ascii_lowercase()]
}

fn valid_mcp_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && !s.chars().any(|c| c.is_control())
}

/// 判定一次 MCP 工具调用。名字非法直接 Deny（不给弹框机会），
/// 其余情况新会话必 Ask，授权只解锁自己的 scope。
pub fn decide_mcp(session_id: &str, server: &str, tool: &str) -> Decision {
    if !valid_mcp_name(server) || !valid_mcp_name(tool) {
        return Decision::Deny { reason: "MCP 服务器名或工具名非法".into() };
    }
    let scope = mcp_scope(server, tool);
    if consume_scope(session_id, &scope) {
        return Decision::Allow;
    }
    Decision::Ask {
        label: format!("MCP {server}/{tool}"),
        scope,
    }
}

/// MCP 调用的唯一闸门：`mcp_call_tool` IPC 在任何 tools/call 之前必须先过它。
pub fn guard_mcp(session_id: &str, server: &str, tool: &str) -> Result<(), GateDenied> {
    match decide_mcp(session_id, server, tool) {
        Decision::Allow => Ok(()),
        Decision::Ask { scope, label } => Err(GateDenied::NeedGrant { scope, label }),
        Decision::Deny { reason } => Err(GateDenied::Refused { reason }),
    }
}

/// 记一条授权。`uses` 为 `Some(n)` 表示还能用 n 次，`None` 表示本会话内不限次。
///
/// 同一个 scope 重复授权时取「更宽」的那一个：用户先批了 1 次又批了本会话，
/// 后一次的意思显然是覆盖前一次，不该变成"1 次用完就没了"。
pub fn grant(session_id: &str, scope: &[String], uses: Option<u32>, label: String) -> Vec<Grant> {
    // 空 scope 或含控制字符的 scope 直接不接受：这不该从界面传进来，
    // 传进来就说明调用方在拼装输入，不能让它污染记账表。
    if scope.is_empty() || scope.iter().any(|s| s.is_empty() || s.chars().any(|c| c.is_control())) {
        return list(session_id);
    }
    let scope: Vec<String> = scope.iter().map(|s| s.to_ascii_lowercase()).collect();
    let mut map = lock();
    let list = map.entry(session_id.to_string()).or_default();
    if let Some(g) = list.iter_mut().find(|g| g.scope == scope) {
        g.uses_left = match (g.uses_left, uses) {
            (None, _) | (_, None) => None,
            (Some(a), Some(b)) => Some(a.max(b)),
        };
        if !label.is_empty() {
            g.label = label;
        }
    } else {
        list.push(Grant { scope, uses_left: uses, label });
    }
    list.clone()
}

/// 撤销授权。`scope` 为 `None` 时清空该会话的全部授权。
pub fn revoke(session_id: &str, scope: Option<&[String]>) -> Vec<Grant> {
    let mut map = lock();
    match scope {
        None => {
            map.remove(session_id);
            Vec::new()
        }
        Some(s) => {
            let want: Vec<String> = s.iter().map(|x| x.to_ascii_lowercase()).collect();
            let out = if let Some(list) = map.get_mut(session_id) {
                list.retain(|g| g.scope != want);
                if list.is_empty() {
                    map.remove(session_id);
                    Vec::new()
                } else {
                    list.clone()
                }
            } else {
                Vec::new()
            };
            out
        }
    }
}

/// 会话关闭时必须调用：授权跟着会话走，会话没了授权就该没了。
pub fn clear_session(session_id: &str) {
    lock().remove(session_id);
}

pub fn list(session_id: &str) -> Vec<Grant> {
    lock().get(session_id).cloned().unwrap_or_default()
}

/// 闸门拒绝的两种原因。区分它们是为了让界面做对不同的事：
/// 需要授权 → 弹框问用户；被白名单拒 → 直接把原因告诉模型，弹框没有意义。
#[derive(Debug, Clone, PartialEq)]
pub enum GateDenied {
    NeedGrant { scope: Vec<String>, label: String },
    Refused { reason: String },
}

impl GateDenied {
    /// 序列化成 JSON 字符串交给前端。
    ///
    /// 之所以用字符串而不是让 Tauri 直接序列化结构体：前端现有的错误通道
    /// （`errText`）只处理字符串与 Error，抛对象会变成 "[object Object]"，
    /// 界面就没法区分「该弹框」和「该报错」了。
    pub fn to_json(&self) -> String {
        let v = match self {
            GateDenied::NeedGrant { scope, label } => serde_json::json!({
                "kind": "need_grant",
                "scope": scope,
                "label": label,
            }),
            GateDenied::Refused { reason } => serde_json::json!({
                "kind": "refused",
                "reason": reason,
            }),
        };
        v.to_string()
    }
}

/// 唯一的执行闸门：所有执行入口都必须经过它。
///
/// 放在这里而不是 lib.rs，是为了让 `tools/fs-harness` 能测到**同一份实现**。
/// harness 引用不了 lib.rs（tauri 的 WebView2 导入库在本机起不来），
/// 如果在 harness 里另写一份"模拟闸门"，测的就不是生产代码了。
pub fn guard(session_id: &str, argv: &[String]) -> Result<(), GateDenied> {
    match decide(session_id, argv) {
        Decision::Allow => Ok(()),
        Decision::Ask { scope, label } => Err(GateDenied::NeedGrant { scope, label }),
        Decision::Deny { reason } => Err(GateDenied::Refused { reason }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// 每个用例用自己的 session id，互不干扰（这个表是进程级单例）
    fn sid(tag: &str) -> String {
        format!("test-{tag}-{}", std::process::id())
    }

    #[test]
    fn fresh_session_must_ask_even_for_allowlisted_commands() {
        let s = sid("fresh");
        // npm test 是白名单命令，但新会话没有授权 → 必须是 ask，不是 allow
        assert!(matches!(decide(&s, &argv(&["npm", "test"])), Decision::Ask { .. }));
        assert!(matches!(decide(&s, &argv(&["git", "status"])), Decision::Ask { .. }));
        // 反复问也不会自己变成 allow
        for _ in 0..3 {
            assert!(matches!(decide(&s, &argv(&["npm", "test"])), Decision::Ask { .. }));
        }
    }

    #[test]
    fn non_allowlisted_is_denied_not_asked() {
        let s = sid("deny");
        // 白名单不过就该直接拒，不给界面弹框的机会
        match decide(&s, &argv(&["npm", "install"])) {
            Decision::Deny { reason } => assert!(reason.contains("npm 只允许"), "{reason}"),
            other => panic!("必须是 Deny，实际 {other:?}"),
        }
        assert!(matches!(decide(&s, &argv(&["git", "push"])), Decision::Deny { .. }));
        assert!(matches!(decide(&s, &argv(&[])), Decision::Deny { .. }));
    }

    #[test]
    fn grant_unlocks_only_its_own_scope() {
        let s = sid("scope");
        grant(&s, &["npm".into(), "test".into()], None, "npm test".into());
        assert_eq!(decide(&s, &argv(&["npm", "test"])), Decision::Allow);
        // 带安全过滤词仍是同一个 scope（白名单已经限定了过滤词形状）
        assert_eq!(decide(&s, &argv(&["npm", "test", "src/a.test.ts"])), Decision::Allow);
        // 但同一条授权不能外溢到别的命令
        assert!(matches!(decide(&s, &argv(&["npm", "run", "build"])), Decision::Ask { .. }));
        assert!(matches!(decide(&s, &argv(&["git", "status"])), Decision::Ask { .. }));
        // npm run build 与 npm run lint 是两条脚本，必须分开
        grant(&s, &["npm".into(), "run".into(), "build".into()], None, "build".into());
        assert_eq!(decide(&s, &argv(&["npm", "run", "build"])), Decision::Allow);
        assert!(matches!(decide(&s, &argv(&["npm", "run", "lint"])), Decision::Ask { .. }));
    }

    #[test]
    fn one_shot_grant_is_consumed_and_then_asks_again() {
        let s = sid("oneshot");
        grant(&s, &["git".into(), "status".into()], Some(1), "status".into());
        assert_eq!(decide(&s, &argv(&["git", "status"])), Decision::Allow);
        // 用完之后必须重新问，不能变成事实上的常驻授权
        assert!(matches!(decide(&s, &argv(&["git", "status"])), Decision::Ask { .. }));
    }

    #[test]
    fn grants_are_per_session_and_cleared_on_close() {
        let a = sid("a");
        let b = sid("b");
        grant(&a, &["npm".into(), "test".into()], None, "npm test".into());
        assert_eq!(decide(&a, &argv(&["npm", "test"])), Decision::Allow);
        // 另一个会话不受影响：授权不能跨会话继承
        assert!(matches!(decide(&b, &argv(&["npm", "test"])), Decision::Ask { .. }));
        // 会话关闭后授权立即失效
        clear_session(&a);
        assert!(matches!(decide(&a, &argv(&["npm", "test"])), Decision::Ask { .. }));
        assert!(list(&a).is_empty());
    }

    #[test]
    fn revoke_removes_one_scope_or_all() {
        let s = sid("revoke");
        grant(&s, &["npm".into(), "test".into()], None, "npm test".into());
        grant(&s, &["git".into(), "status".into()], None, "git status".into());
        revoke(&s, Some(&["npm".into(), "test".into()]));
        assert!(matches!(decide(&s, &argv(&["npm", "test"])), Decision::Ask { .. }));
        assert_eq!(decide(&s, &argv(&["git", "status"])), Decision::Allow);
        revoke(&s, None);
        assert!(matches!(decide(&s, &argv(&["git", "status"])), Decision::Ask { .. }));
        assert!(list(&s).is_empty());
    }

    #[test]
    fn grant_scope_cannot_be_poisoned() {
        let s = sid("poison");
        // 空 scope、空项、控制字符都不该被记进表里——那会让匹配逻辑失效
        assert!(grant(&s, &[], None, "x".into()).is_empty());
        assert!(grant(&s, &["".into()], None, "x".into()).is_empty());
        assert!(grant(&s, &["npm\n".into()], None, "x".into()).is_empty());
        assert!(list(&s).is_empty());
    }

    #[test]
    fn scope_normalizes_case_and_exec_suffix() {
        // 授权 npm test 之后，模型用 npm.cmd 来跑，不该需要重新批一次
        let s = sid("norm");
        grant(&s, &["npm".into(), "test".into()], None, "npm test".into());
        assert_eq!(decide(&s, &argv(&["npm.cmd", "test"])), Decision::Allow);
        // 命令名大写会被白名单直接拒掉（is_allowed 的 match 大小写敏感）。
        // 这是有意的保守：拒绝比猜测模型意图安全，所以这里必须是 Deny 而不是 Allow。
        assert!(matches!(decide(&s, &argv(&["NPM", "TEST"])), Decision::Deny { .. }));
        // scope_of 本身做归一化，保证「同一命令的不同写法」落到同一个授权格子里
        assert_eq!(scope_of(&argv(&["NPM.CMD", "TEST"])), vec!["npm", "test"]);
    }

    #[test]
    fn repeated_grant_keeps_the_wider_one() {
        let s = sid("wider");
        grant(&s, &["npm".into(), "test".into()], Some(1), "once".into());
        grant(&s, &["npm".into(), "test".into()], None, "session".into());
        // 先批一次、再批本会话：后者覆盖前者，不该变成"1 次就没了"
        for _ in 0..3 {
            assert_eq!(decide(&s, &argv(&["npm", "test"])), Decision::Allow);
        }
        // 反向：已有本会话授权时再批 1 次，不该把范围收窄
        grant(&s, &["git".into(), "status".into()], None, "session".into());
        grant(&s, &["git".into(), "status".into()], Some(1), "once".into());
        for _ in 0..3 {
            assert_eq!(decide(&s, &argv(&["git", "status"])), Decision::Allow);
        }
    }

    #[test]
    fn scope_of_shapes() {
        assert_eq!(scope_of(&argv(&["npm", "test", "a.test.ts"])), vec!["npm", "test"]);
        assert_eq!(scope_of(&argv(&["npm", "run", "build"])), vec!["npm", "run", "build"]);
        assert_eq!(scope_of(&argv(&["npx", "vitest", "run", "a.test.ts"])), vec!["npx", "vitest", "run"]);
        assert_eq!(scope_of(&argv(&["git", "diff", "--stat"])), vec!["git", "diff"]);
        assert_eq!(scope_of(&argv(&["node", "--version"])), vec!["node", "--version"]);
        assert!(scope_of(&[]).is_empty());
    }

    // ---- ADR 0004：MCP 工具授权闸门（与 exec 共用同一张授权表） ----

    #[test]
    fn mcp_fresh_session_must_ask() {
        let s = sid("mcp-fresh");
        assert!(matches!(
            decide_mcp(&s, "context-mode", "ctx_execute"),
            Decision::Ask { .. }
        ));
        assert!(matches!(
            guard_mcp(&s, "context-mode", "ctx_execute"),
            Err(GateDenied::NeedGrant { .. })
        ));
        for _ in 0..3 {
            assert!(matches!(
                decide_mcp(&s, "context-mode", "ctx_execute"),
                Decision::Ask { .. }
            ));
        }
    }

    #[test]
    fn mcp_grant_unlocks_only_its_own_scope() {
        let s = sid("mcp-scope");
        grant(
            &s,
            &mcp_scope("context-mode", "ctx_execute"),
            None,
            "MCP context-mode/ctx_execute".into(),
        );
        assert_eq!(decide_mcp(&s, "context-mode", "ctx_execute"), Decision::Allow);
        assert!(matches!(
            decide_mcp(&s, "context-mode", "ctx_search"),
            Decision::Ask { .. }
        ));
        assert!(matches!(
            decide_mcp(&s, "other", "ctx_execute"),
            Decision::Ask { .. }
        ));
        assert!(matches!(
            decide(&s, &argv(&["npm", "test"])),
            Decision::Ask { .. }
        ));
    }

    #[test]
    fn mcp_one_shot_grant_is_consumed() {
        let s = sid("mcp-oneshot");
        grant(&s, &mcp_scope("a", "x"), Some(1), "MCP a/x".into());
        assert_eq!(decide_mcp(&s, "a", "x"), Decision::Allow);
        assert!(matches!(decide_mcp(&s, "a", "x"), Decision::Ask { .. }));
    }

    #[test]
    fn mcp_invalid_names_are_denied_not_asked() {
        let s = sid("mcp-invalid");
        for (server, tool) in [("", "x"), ("a", ""), ("a\nb", "x"), ("a", "x\ty")] {
            match decide_mcp(&s, server, tool) {
                Decision::Deny { reason } => assert!(reason.contains("非法"), "{reason}"),
                other => panic!("必须是 Deny，实际 {other:?}"),
            }
        }
        assert!(matches!(
            guard_mcp(&s, "", "x"),
            Err(GateDenied::Refused { .. })
        ));
    }

    #[test]
    fn mcp_scope_is_normalized() {
        assert_eq!(
            mcp_scope("Context-Mode", "CTX_EXECUTE"),
            vec!["mcp", "context-mode", "ctx_execute"]
        );
        assert_ne!(mcp_scope("a", "x"), mcp_scope("b", "x"));
        assert_ne!(mcp_scope("a", "x"), mcp_scope("a", "y"));
    }

    #[test]
    fn mcp_grant_does_not_unlock_exec_and_vice_versa() {
        let s = sid("mcp-no-cross");
        grant(&s, &["mcp".into(), "a".into(), "x".into()], None, "MCP a/x".into());
        assert_eq!(decide_mcp(&s, "a", "x"), Decision::Allow);
        assert!(matches!(
            decide(&s, &argv(&["git", "status"])),
            Decision::Ask { .. }
        ));
        grant(&s, &["git".into(), "status".into()], None, "git status".into());
        assert!(matches!(decide_mcp(&s, "b", "y"), Decision::Ask { .. }));
    }
}
