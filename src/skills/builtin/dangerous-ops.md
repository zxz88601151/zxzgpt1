---
name: 危险操作
description: 写删除、迁移、部署、批量修改、密钥相关的代码或命令时加载：不可逆的写法必须给安全替代，并在同一行标清后果——因为这个工具不会替你执行，跑的人是用户。
triggers: [删除, 迁移, 部署, 清空, 回滚, drop, truncate, 密钥, 环境变量, 批处理, 强制推送]
version: 1.0.0
category: 安全
stage: review
---

# 危险操作

本工具不执行命令，也不会弹窗问「确定吗」。你写的每一行脚本、每条 SQL、每个部署命令，
**最终是被用户复制到自己机器上跑的**。

所以这里的要求和别人不一样：不是「执行前先确认」，而是**在交付的那一刻就把后果写在代码里**。

## 一条硬规矩

```
不可逆的操作，要么给可逆写法，要么在同一行标出后果。
```

两者都没有，就不要写。

## 什么是不可逆

| 类别 | 典型写法 | 后果 |
| --- | --- | --- |
| 递归删除 | `rm -rf <目录>`、`Remove-Item -Recurse -Force` | 目录内容没了，回收站也没有 |
| 清空表 | `TRUNCATE`、`DROP TABLE`、`DELETE` 不带 `WHERE` | 数据没了，`DELETE` 还能靠备份，另两个连表结构都没了 |
| 改历史 | `git push --force`、`git reset --hard`、`git checkout .` | 别人拉到的提交没了，未提交的改动丢了 |
| 迁移不可回滚 | 加字段时顺手删旧字段、改字段类型、拆表 | 老代码还在读旧字段时会直接报错 |
| 批量改文件 | 遍历目录改名 / 覆盖 / 格式化 | 改错了没有 undo |
| 基础设施变更 | `terraform apply`、`kubectl delete`、`docker system prune` | 影响线上，且申请资源容易、恢复难 |
| 覆盖远端 | `git push` 到共享分支、`npm publish` | 已经发出去就收不回来 |

## 该怎么写

**能可逆就写可逆的：**

```sql
-- ❌ 一步到位，删了就没了
ALTER TABLE orders DROP COLUMN legacy_flag;

-- ✅ 分两步，中间留一个版本可以回头
-- 第 1 步（本次）：停止写入
-- 第 2 步（下个版本，确认无读取后）：ALTER TABLE orders DROP COLUMN legacy_flag;
```

```bash
# ❌ 直接删
rm -rf ./data

# ✅ 先移到备份目录，确认后再删
mv ./data "./data.bak.$(date +%Y%m%d-%H%M%S)"
```

**不能可逆就标清：**

```bash
# ⚠️ 不可逆：会清空 orders 表全部数据，执行前请先 mysqldump 备份
mysql -u root -p shop -e "TRUNCATE TABLE orders;"
```

```ts
// ⚠️ 不可逆：删除后文件不进回收站，无法恢复
await fs.rm(dir, { recursive: true, force: true });
```

标注要写在**那一行紧邻的位置**，不是放在文件头或文档末尾——用户是逐段复制的，注释离得远等于没有。

## 放行清单

这几类递归删除是日常操作，不必标红（但目录名要写死，不要用变量拼接）：

`node_modules` · `dist` · `build` · `.next` · `.cache` · `__pycache__` · `.turbo` · `coverage`

写成 `rm -rf ./dist` 可以；写成 `rm -rf $TARGET` 不行——变量拼错一次就是灾难。

## 密钥与凭证

这条是从外部技能库的审计里挑出来的，只有一句但很值：

```
密钥走环境变量，永远不进命令行参数。
```

- `--token=xxx`、`-p 密码`、`?api_key=xxx` 都会留在 shell history 和进程列表里，同机任何人都能 `ps` 看到。
- 正确做法：`export API_TOKEN=...` 后用 `$API_TOKEN`，或写进 `.env` 并确保 `.gitignore` 覆盖它。
- 不要在生成的代码里写真实密钥、示例密钥长得像真的（`sk-live-...`）。用 `process.env.X` 或 `"<your-token>"` 占位。
- 不要在日志、错误信息、URL 里带密钥。

## 交付前自检

- [ ] 有没有 `rm -rf` / `DROP` / `TRUNCATE` / `--force` / `reset --hard`？逐个看是不是必要
- [ ] 每条不可逆操作，要么换成了可逆写法，要么同行有 `⚠️` 注释说明后果
- [ ] 删除路径是写死的字面量，不是变量拼接
- [ ] 迁移脚本能向前兼容（旧代码在新 schema 上还能跑）
- [ ] 密钥只从环境变量读，没有出现在命令行参数、代码字面量、日志里
- [ ] 批量操作给了「先 dry-run 看一眼」的版本
