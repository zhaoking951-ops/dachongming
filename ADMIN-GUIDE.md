# 管理后台指南

## 首次使用

1. 部署面板并配置 HTTPS
2. 注册首个账号（自动成为管理员）
3. 进入 `/admin` → 设置 → 配置 SMTP（其他用户需要邮件验证码才能注册）
4. 配置完成后开放注册

## 功能模块

### 节点管理

- 智能部署 VLESS Reality / Shadowsocks / Hysteria 2（SSH 密码或 Key）
- 编辑节点信息、流量倍率、用户组等级限制
- 重启 Xray / Hysteria 2
- 同步配置到节点
- AWS 绑定与一键换 IP（支持 EC2 / Lightsail / Wavelength）
- 节点 AI 标签（基于审计日志识别近期换 IP 等动作）

### 用户管理

- 搜索、分页、排序
- 设置用户组 / 流量限额 / 到期时间 / 最大设备数
- 封禁 / 解封 / 删除
- 重置订阅 Token
- 查看流量来源、签到记录、风险统计
- 邀请关系树（谁邀请了谁）

### 流量统计

- 用户 / 节点流量排行
- 时间范围切换（1h / 24h / 7d / 30d）
- 7 天趋势与来源分析

### 安全与运维

- 审计日志（操作可追溯）
- 订阅访问统计与风控（IP 限流、Token 限流、行为分析）
- 多节点并发使用观察
- 节点健康汇总
- Agent WebSocket 状态监控
- 运维诊断与 AI 运营日记（蜜桃酱）
- Agent 批量自更新

### AWS

- 多账号管理（EC2 / Lightsail）
- 一键创建实例并部署
- 节点绑定实例
- 实例换 IP（含 Wavelength 弹性 IP / Lightsail 静态 IP）
- 区域支持：覆盖 33+ AWS 商用区域，含吉隆坡、曼谷等较新区域

新增账号只需填写账号名、Access Key、Secret Key 和可选代理，保存后自动查询实例。AWS 账号可以同时在多个区域拥有实例，面板会按实际发现的区域展示，不要求用户提前填写或猜测区域。旧数据库的默认区域值不再限制自动发现范围，升级保留已有密钥和代理配置。

新增或编辑账号时可选择「查询服务」：EC2 和 Lightsail、仅 EC2、仅 Lightsail。只使用 EC2 的账号可选「仅 EC2」，面板不会发起 Lightsail 查询；不需要为了查询 EC2 而额外授予 Lightsail 权限。升级保留旧账号的双服务查询范围，保存修改后自动刷新实例。

「区域筛选」默认勾选「自动发现实例所在区域」。面板使用各账号的凭据，通过 EC2 `DescribeRegions` 获取该账号已启用的区域，通过 Lightsail `GetRegions` 获取服务支持的区域，再查询所选服务的实例。只读区域发现需要所选服务对应的 `ec2:DescribeRegions` 或 `lightsail:GetRegions`，实例查询需要 `ec2:DescribeInstances` 或 `lightsail:GetInstances` 等对应权限。EC2 区域目录查询失败时会显示错误，并尝试项目内已知区域；Lightsail 区域目录查询失败则停止本次 Lightsail 自动扫描，避免跨区域重复失败。如果凭据允许查询 Lightsail 实例但不允许读取区域目录，可手动选择区域重试。某个服务失败不会隐藏其他服务查到的实例。

关闭自动发现后，可以手动缩小查询区域；全不选则不查询。以前保存的手动区域列表会保留，勾选自动发现并保存即可恢复自动查询。多区域实例会全部按所在区域展示，不会自动把账号归属到某一个区域。

刷新实例最多并发 6 个查询，单个区域服务查询最多等待 12 秒，整次刷新最多等待约 45 秒。多区域查询超过时限时，可以缩小筛选范围后重试。部分查询失败显示简短提示，详情默认折叠，重复错误按服务和错误原因合并并列出相关区域；仍可展开查看错误代码，或直接进入该账号的查询服务设置。全部查询失败会明确显示失败，不能当作没有实例。失败结果不缓存。

区域列表本身不表示哪些区域有实例；必须继续查询实例才能确定。区域发现也受上述并发和超时限制。区域目录调用使用 `us-east-1` 作为引导端点，这不代表账号或实例位于美国。自动模式接受 AWS 返回的新区域，不局限于项目内静态列表。

AWS 文档：[EC2 DescribeRegions](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeRegions.html)、[Lightsail GetRegions](https://docs.aws.amazon.com/lightsail/2016-11-28/api-reference/API_GetRegions.html)。

数据库启动时自动补建 `aws_accounts`，兼容新安装、旧库升级及已经手工创建的同结构表，不需要重新添加已有账号。若 AWS CLI 正常但面板仍失败，请按页面显示的区域、服务和错误代码核对面板中保存的凭据、IAM 权限以及代理配置。

### 设置

- SMTP 邮件
- Telegram 通知（节点上下线 / 被墙 / 流量超标 / 注册 / 部署 / 自动轮换 / OPS 操作）
- 公告管理（顶部滚动公告）
- 注册控制（开关 / 邀请码强制）
- 默认流量限额
- 订阅可见性（VLESS / SS / Hy2 协议开关）
- 用户组 UUID / 订阅 Token 重置周期
- 订阅风控阈值（IP/Token/行为窗口和上限）
- 自动化策略：
    - **流量超标**：仅通知 / 超阈值冻结
    - **TG 未签到自动冻结**：30 天未在 TG 签到自动冻结，签到一次自动解冻

### 备份

- 创建 / 下载 SQLite 数据库备份
- 从备份恢复（会覆盖当前数据）
- 每日自动备份（保留近 7 天）

## Telegram Bot

需配置 `TG_BOT_TOKEN`。

| 命令 | 功能 |
|---|---|
| `/start` | 打开主菜单（含深度链接绑定 `/start bind_<token>`） |
| `/bind <token>` | 手动绑定面板账号 |
| `/checkin` | 每日签到（随机 5-10GB） |
| `/lucky` | 每周大转盘（WebApp） |
| `/flip` | 每日翻卡（WebApp） |
| `/rps` | 猜拳赢流量（WebApp） |
| `/me` | 个人信息（用户组、流量、订阅状态） |
| `/sub` | 获取订阅链接 |
| `/traffic` | 查看流量使用情况 |
| `/nodes` | 查看节点列表概览 |
| `/adminstats` | 管理员总览（仅管理员） |

签到累计天数自动升级用户组：
- 7 天 → 解锁家宽 IP 节点
- 15 天 → 升级到 SVIP
- 30 天 → 升级到 SSVIP

## OPS API

OPS API 使用独立 Bearer Token 认证，可被 OpenClaw 或外部系统调用：

```bash
source /root/panel/.env
curl -s -H "Authorization: Bearer $OPS_API_KEY" http://127.0.0.1:3000/ops/api/status
```

详见 [API 参考](./README-API.md)。

## 探针

`/monitor` 页面对所有登录用户开放（不含管理员才能看的敏感信息）。展示：
- 节点机器实时性能（CPU / 内存 / 磁盘 / 负载）
- 网络带宽（上行/下行 速率与累计）
- Agent 在线状态
- xray/Hysteria 服务存活
- 各节点单独的历史趋势图

## 常用排查

```bash
pm2 list                              # 进程状态
pm2 logs vless-panel --lines 200      # 查看日志
nginx -t && systemctl reload nginx    # Nginx 配置
sqlite3 /root/panel/data/panel.db     # 数据库
journalctl -u vless-agent -f          # 节点 Agent 日志（在节点上执行）
```

## 数据库结构

主要表：
- `users` — 用户主表
- `nodes` — 节点
- `user_node_uuid` — 用户在每个节点的 UUID 映射
- `traffic` / `traffic_daily` / `traffic_user_total` — 流量记录
- `tg_checkin` / `tg_lucky` / `tg_flip_daily` / `tg_rps_daily` — TG 互动记录
- `audit_log` — 审计日志
- `sub_access_log` / `sub_access_event` — 订阅访问记录
- `invite_codes` — 邀请码
- `node_metrics` — 节点性能指标
- `settings` — 系统设置（KV）

## 风险提示

- 数据库恢复会覆盖当前数据，操作前先备份
- AWS 换 IP、自动冻结、批量更新 Agent 属于有副作用的操作
- OPS API Token 不要暴露在公网，泄露后立刻在 `.env` 中轮换
- 删除节点/用户前确认无在线流量，否则可能导致 Agent 上报失败（已加保护，但仍建议谨慎）
- 默认 `auto_swap_ip` 等自动化开关在新部署时是关闭的，按需开启
