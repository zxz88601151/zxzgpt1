---
name: Node.js 接口规范
description: 写 Express/Fastify 接口、服务层、中间件时的约定：分层、错误模型、入参校验、幂等与超时。
triggers: [接口, api, express, 路由, 后端, 服务端, endpoint, rest, middleware, 中间件]
version: 1.0.0
category: 后端
stage: write
---

# Node.js 接口规范（Express / Fastify）

适用范围：Node.js 20+、TypeScript、Express 或 Fastify 的 HTTP 服务。

## 硬规则

1. **三层分开**：路由（解析入参、返回响应）→ 服务（业务规则）→ 存储（SQL/ORM）。路由里不许出现 SQL，服务层不许碰 `req`/`res`。
2. **入参必须校验**，在进入业务前完成：类型、必填、长度、范围、枚举。校验失败返回 400 并指出字段名，不要返回 500。
3. **错误统一成一个错误类型**，带 `status` 与 `code`：

```ts
export class AppError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
```
   由一个兜底 error middleware 转成 JSON，其它地方只管 `throw new AppError(404, "USER_NOT_FOUND", "用户不存在")`。
4. **响应结构固定**：成功 `{ data: ... }`，失败 `{ error: { code, message, fields? } }`。不要一个接口返回数组、另一个返回 `{list}`。
5. **异步错误必须被捕获**。Express 4 的 async handler 不会自动捕获，统一套 `asyncHandler` 包装或改用 Fastify。
6. **每个外部调用都要有超时**（数据库、HTTP、缓存）。默认不设超时就是故障时不返回，等于全站挂住。
7. **写操作要考虑重复提交**：幂等键、唯一约束或状态机判断至少有一个。不要依赖「用户不会连点」。
8. **不要在 handler 里拼接日志字符串**，用结构化日志 `log.info({ userId, orderId }, "order created")`，别打印 token、密码、完整手机号。
9. **敏感配置全部走环境变量**，代码里出现密钥、连接串、真实域名都算缺陷。
10. **分页必须有序且稳定**：`ORDER BY created_at DESC, id DESC`，只按时间排序在并发写入时会重复/丢行。
11. **健康检查与业务接口分开**，`/health` 不查业务表、不带鉴权。

## 输出约定

- 目录结构：`src/routes/`、`src/services/`、`src/repos/`、`src/middleware/`、`src/errors.ts`。
- 每个接口在注释里写清：方法 + 路径、鉴权要求、请求体、成功响应、主要错误码。

## 自检清单

- [ ] 所有入参都校验过，错误文案指到字段
- [ ] 所有 await 都在 try/catch 或 asyncHandler 内
- [ ] 外部调用有超时与失败处理
- [ ] 写接口有幂等或唯一约束保障
- [ ] 日志不含密钥与个人敏感信息
- [ ] 分页排序稳定，有上限（如 `limit <= 100`）

## 常见反例

```ts
// 反例：路由里直接查库、无校验、无超时、错误吞掉
app.post("/user", async (req, res) => {
  try {
    const r = await db.query(`insert into users(name) values('${req.body.name}')`);
    res.json(r.rows[0]);
  } catch (e) { res.json({ ok: true }); }
});
```

```ts
// 正例：校验 → 服务 → 统一响应
router.post("/users", asyncHandler(async (req, res) => {
  const input = CreateUserSchema.parse(req.body); // zod，失败抛 400
  const user = await userService.create(input);
  res.status(201).json({ data: user });
}));
```
