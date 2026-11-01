---
name: Python 服务端规范
description: 写 Python 脚本/服务时的类型标注、异常、资源管理、日志与并发约定，含 FastAPI 结构建议。
triggers: [python, 脚本, fastapi, pip, 爬虫, flask, pandas, 数据处理]
version: 1.0.0
category: 后端
stage: write
---

# Python 服务端规范

适用范围：Python 3.10+，脚本、CLI、FastAPI 服务。数据科学场景只取其中通用部分。

## 硬规则

1. **公共函数必须标注类型**：参数与返回值都写。`Any` 只允许出现在真正未知的入口，且要注释来源。
2. **不要用可变对象做默认参数**。`def f(items=[])` 是 bug，写 `items: list[str] | None = None` 再在函数里兜底。
3. **异常只捕获你能处理的**。`except Exception: pass` 一律禁止；需要兜底时记 `logger.exception(...)` 并决定是否上抛。
4. **资源用 `with`**：文件、连接、锁、事务。手写 `close()` 容易在异常路径漏掉。
5. **路径用 `pathlib.Path`**，不要手拼字符串；涉及用户输入的路径要 `resolve()` 后确认仍在允许目录内。
6. **日志用 `logging`，不用 `print`**（除 CLI 的人机输出）。日志要带上下文：`logger.info("imported rows=%d file=%s", n, path)`，用惰性格式化。
7. **编码一律显式 `encoding="utf-8"`**，读写文本不要依赖系统默认编码（Windows 上是 GBK，跨平台必炸）。
8. **时间用带时区的 `datetime.now(timezone.utc)`**，不要用 `datetime.now()` 存库；展示层再转本地时区。
9. **拼接 SQL 用参数占位**（`?` / `%s` / SQLAlchemy 参数），f-string 拼 SQL 一律算安全缺陷。
10. **阻塞 IO 不要放在事件循环里**。FastAPI 的 `async def` 里调用同步库要用 `run_in_threadpool` 或改成普通 `def`。
11. **I/O 密集用线程池/异步，CPU 密集用多进程**；不要为了「快」在 async 函数里写 `time.sleep`。
12. **配置文件集中读取一次**（pydantic-settings / dataclass），不要在函数里散落 `os.getenv`。

## FastAPI 结构建议

```
app/
  main.py          只做 app 装配、异常处理器注册
  api/routes_*.py  路由：校验入参、调用 service、返回 schema
  services/        业务逻辑，不依赖 Request
  models/          ORM 与 pydantic schema 分开
  core/config.py   Settings
  core/errors.py   AppError + exception_handler
```

## 自检清单

- [ ] 公共函数有类型标注，`mypy` 能过（或至少没有明显 Any 泛滥）
- [ ] 没有可变默认参数、没有空 except
- [ ] 所有文件/连接都在 `with` 里
- [ ] 文本 IO 指定了 utf-8
- [ ] SQL 全部参数化
- [ ] async 函数里没有阻塞调用

## 常见反例

```python
# 反例：可变默认值 + 空 except + 拼 SQL + print 当日志
def load(ids=[]):
    try:
        cur.execute(f"select * from t where id in ({','.join(ids)})")
        print("ok")
    except:
        pass
```

```python
# 正例
def load(ids: Sequence[int]) -> list[Row]:
    if not ids:
        return []
    marks = ",".join("?" * len(ids))
    with connect() as conn, conn.cursor() as cur:
        cur.execute(f"select * from t where id in ({marks})", tuple(ids))
        rows = cur.fetchall()
    logger.info("loaded rows=%d", len(rows))
    return rows
```
