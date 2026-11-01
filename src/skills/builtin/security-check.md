---
name: 安全自查
description: 涉及登录、鉴权、上传、外部请求、密钥、SQL 时加载：按攻击面逐项过，给出"有/没有"的事实判断而不是泛泛提醒。
triggers: [安全, 鉴权, 登录, 权限, 注入, 密钥, token, xss, csrf, 越权, 上传]
version: 1.0.0
category: 安全
stage: review
---

# 安全自查

适用范围：服务端接口、鉴权流程、文件读写、对外请求、前端渲染。做渗透测试/漏洞利用不在此范围。

## 硬规则

1. **鉴权在服务端，不在前端**。前端隐藏按钮不算权限控制；每个接口都要在服务端确认「这个用户能不能操作这个资源」，且判断基于服务端取到的 `userId`，不信任请求体里的 `userId`。
2. **越权分两类都要查**：水平（A 用户改 B 用户的订单）与垂直（普通用户调管理接口）。查法：把资源 id 换成别人的，看是否仍 200。
3. **SQL 只有一条路**：参数化查询。任何字符串拼接 SQL、`ORDER BY ${col}`、`LIKE '%${q}%'` 都是缺陷；动态排序字段要用白名单映射。
4. **密钥不落代码、不落前端包、不进日志**。前端只能拿短期令牌；`.env` 必须在 `.gitignore` 里；日志里对 token 打码。
5. **输出要转义**：HTML 用框架默认转义，`innerHTML` / `dangerouslySetInnerHTML` 必须基于已消毒的内容（白名单过滤），URL 参数进 `href` 前校验协议（只允许 http/https，拒绝 `javascript:`）。
6. **文件路径不得由用户完全控制**。落盘前规范化并确认仍在允许目录内（拒绝 `..`、绝对路径、盘符、符号链接逃逸），上传限制大小与扩展名。
7. **认证令牌最小化**：短有效期 + 可撤销；存 Cookie 时加 `HttpOnly`、`SameSite=Lax`、生产环境 `Secure`；不要把长期令牌放 localStorage 又允许任意脚本读取。
8. **口令用慢哈希**（bcrypt / argon2），不自己造盐值方案，不用 MD5/SHA1 存密码。
9. **限流与防爆破**：登录、发码、导出接口必须有速率限制；错误文案不区分「用户不存在」与「密码错误」。
10. **依赖也要看**：新引入的包检查是否必需、是否活跃维护；不引入来源不明的构建脚本。
11. **报错不泄露内部信息**：对外只返回错误码与可读文案，堆栈只进日志。
12. **CORS 白名单**，不要 `Access-Control-Allow-Origin: *` 配 `credentials`。

## 自检清单（逐项给结论，不要笼统说"注意安全"）

- [ ] 每个写接口都有服务端权限校验，且校验对象来自会话而非请求体
- [ ] 所有 SQL 参数化；动态排序/表名走白名单
- [ ] 用户输入渲染前转义；`innerHTML` 处有消毒
- [ ] 文件路径经过规范化与根目录校验
- [ ] 密钥不在仓库、不在前端、不在日志
- [ ] 令牌可撤销、有有效期，Cookie 属性齐全
- [ ] 敏感接口有限流
- [ ] 对外错误信息不含堆栈、SQL、路径

## 输出约定

按「接口/文件 → 结论（通过 / 风险 / 缺陷）→ 依据（看到的具体代码）→ 修法」写成表，不要写成通用安全常识。

## 常见反例

```ts
// 反例：权限靠前端、userId 来自请求体、SQL 拼接
app.delete("/orders/:id", async (req, res) => {
  await db.query(`delete from orders where id = ${req.params.id} and user_id = ${req.body.userId}`);
  res.json({ ok: false });
});
```

```ts
// 正例：userId 取自会话，参数化，明确 404 而不是 403（不泄露资源是否存在）
app.delete("/orders/:id", requireAuth, async (req, res) => {
  const { rowCount } = await db.query("delete from orders where id = $1 and user_id = $2", [
    req.params.id,
    req.user.id,
  ]);
  if (!rowCount) throw new AppError(404, "ORDER_NOT_FOUND", "订单不存在");
  res.status(204).end();
});
```
