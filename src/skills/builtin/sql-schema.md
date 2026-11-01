---
name: 数据库表结构规范
description: 建表、加索引、写迁移、写查询时的约定：命名、类型、约束、索引选择、事务边界与向后兼容。
triggers: [数据库, 建表, sql, mysql, 索引, 迁移, schema, 表结构, postgres, 查询]
version: 1.0.0
category: 数据
stage: write
---

# 数据库表结构规范（MySQL 8 / PostgreSQL）

适用范围：关系型数据库的表设计、索引、迁移与常见查询。

## 硬规则

1. **命名统一**：表名复数小写下划线（`orders`），字段小写下划线（`created_at`），主键 `id`，外键 `<单数表名>_id`，索引 `idx_<表>_<字段>`，唯一索引 `uk_<表>_<字段>`。
2. **每张表必须有主键**，并带 `created_at`、`updated_at`。业务上不需要也要有——否则改数据时无法定位唯一行。
3. **金额用定点数**（`DECIMAL(18,2)`）或整数分，禁止 `FLOAT`/`DOUBLE` 存钱。
4. **时间统一带时区**：PostgreSQL 用 `timestamptz`，MySQL 用 `DATETIME` 且应用层统一写 UTC。禁止混用本地时间。
5. **能约束的就约束**：`NOT NULL`、`UNIQUE`、`CHECK`、外键。默认值只在语义明确时加，不要用 `DEFAULT ''` 掩盖缺失。
6. **状态字段用短字符串或明确枚举**，不要用无注释的魔法数字；取值在注释里列全。
7. **索引按查询建，不按字段建**：先写出真实查询，再看 `WHERE` + `ORDER BY` 组合。联合索引把等值条件放前面、范围条件放最后。
8. **不要在索引列上套函数**（`WHERE DATE(created_at) = ?` 会让索引失效），改写成范围条件 `created_at >= ? AND created_at < ?`。
9. **软删除要统一**：`deleted_at` 为 null 表示未删，所有查询都要带这个条件，或改用视图，避免漏加导致脏数据。
10. **迁移只做向前兼容的加法**：先加可空字段/新表 → 双写 → 回填 → 切读 → 再删旧字段。禁止在同一次迁移里既改名又删列。
11. **大表加索引与改结构要评估锁**，说明是否需要在低峰执行、是否需要 `ALGORITHM=INPLACE`。
12. **事务边界要小且明确**：事务里不做网络调用、不发消息、不写文件。

## 输出约定

- 建表语句附带：字段注释、索引说明、预计数据量与增长方式。
- 迁移脚本成对给出 `up` 与 `down`，并说明回滚是否安全。

## 自检清单

- [ ] 有主键、`created_at`、`updated_at`
- [ ] 金额与时间类型正确
- [ ] 所有查询条件都有对应索引，且没有对索引列套函数
- [ ] 唯一性由约束保证，而不是靠应用层判断
- [ ] 迁移可重复执行、可回滚，且不破坏旧版本代码
- [ ] 没有 `SELECT *` 用于生产接口（字段变更会直接炸）

## 常见反例

```sql
-- 反例：无主键、金额用 float、状态是魔法数字、索引套函数
CREATE TABLE order (
  amount FLOAT,
  status INT,
  create_time VARCHAR(20)
);
SELECT * FROM order WHERE DATE(create_time) = '2026-11-01';
```

```sql
-- 正例
CREATE TABLE orders (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  user_id       BIGINT UNSIGNED NOT NULL,
  amount        DECIMAL(18,2)   NOT NULL,
  status        VARCHAR(16)     NOT NULL DEFAULT 'pending' COMMENT 'pending|paid|shipped|closed',
  created_at    DATETIME        NOT NULL,
  updated_at    DATETIME        NOT NULL,
  deleted_at    DATETIME        NULL,
  KEY idx_orders_user_created (user_id, created_at)
);
```
