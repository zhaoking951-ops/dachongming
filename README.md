# 大聪明

<img src="./public/favicon.svg" alt="大聪明 Logo" width="96" height="96">

> 一个为个人和小团队打造的多协议代理管理面板。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-5-lightgrey.svg)](https://expressjs.com)

基于 Node.js + Express + SQLite，把用户、节点、订阅、流量、运维放进一套系统。覆盖 VLESS Reality / Shadowsocks / Hysteria 2 三种协议，支持邮箱注册、AWS EC2/Lightsail 节点编排、Telegram 互动游戏、自动化运维巡检。

本项目基于 [vzzoxo/xiaoyizi](https://github.com/vzzoxo/xiaoyizi) 修改维护，感谢上游作者与贡献者。当前公开仓库为 [zhaoking951-ops/dachongming](https://github.com/zhaoking951-ops/dachongming)，保留原项目的 MIT 许可证与版权声明。

## 功能

### 核心
- **多协议**：VLESS Reality / Shadowsocks / Hysteria 2
- **用户系统**：邮箱注册登录、密码找回、邀请码、用户分组、流量限额、到期冻结
- **订阅分发**：UA 自动识别（Clash/Sing-box/v2ray/Shadowrocket 等）、签名防盗链、IP/Token 限流、滥用检测
- **节点部署**：一键部署到任意 VPS，支持 SSH 密码 / Key、SOCKS5 落地
- **流量统计**：用户/节点维度 + 7 天趋势 + 来源分析
- **健康监控**：Agent WebSocket 长连接 + xray/Hysteria 存活检测 + 资源用量

### 自动化
- **AWS 集成**：EC2 / Lightsail 多账号管理、一键创建实例、换 IP（含 Wavelength）
- **被墙检测**：自动识别 → 自动换 IP → 自动同步配置
- **密钥轮换**：UUID/订阅 Token 按用户组配置周期重置
- **不活跃冻结**：TG 30 天未签到自动冻结，签到一次自动解冻

### Telegram Bot
- **签到**：每日签到领流量，连续天数自动升级用户组（7 天家宽 / 15 天 SVIP / 30 天 SSVIP）
- **小游戏**：大转盘（每周）、翻卡（每日）、猜拳（每日）
- **管理**：`/me` 个人面板、`/sub` 拉订阅、`/adminstats` 管理总览
- **通知**：节点离线/恢复/被墙、用户超量、自动轮换、注册新用户、部署成功/失败

### 运维
- **管理后台**：节点 CRUD / 用户 CRUD / 流量统计 / 安全审计 / 备份恢复
- **探针**：实时性能监控（CPU/内存/磁盘/带宽/延迟），所有登录用户可见
- **审计日志**：操作可追溯，过期自动清理
- **OPS API**：RESTful 接口，可被 OpenClaw 或外部系统调用做巡检和自愈
- **备份**：每日定时备份 + 手动一键备份 + 一键恢复

## 快速部署

使用 root 用户在 Debian 11+ / Ubuntu 20.04+ VPS 上运行。提前将面板域名解析到服务器，并开放 TCP 80/443 端口；建议至少 512 MB 内存，低内存机器需预留 Swap。节点使用的端口需另外放行。

### 一键脚本（推荐）

```bash
REPO_URL=https://github.com/zhaoking951-ops/dachongming.git bash <(curl -fsSL https://raw.githubusercontent.com/zhaoking951-ops/dachongming/main/install.sh)
```

脚本会自动完成：系统依赖 → Node.js → PM2 → 拉取代码 → 配置 .env → Nginx + Let's Encrypt SSL → PM2 启动 → 健康检查。默认安装 Node.js 22；已有 Node.js 20 或更高版本时会直接复用。

安装目录为 `/root/panel`。PM2 进程名与 Nginx 配置名沿用 `vless-panel`，便于已有部署平滑更新。

首个注册用户免邮箱验证码并自动成为管理员；首次打开面板后先完成自己的账号注册。后续用户的邮箱验证需要在后台配置 SMTP，是否开放注册与是否需要邀请码由后台设置控制。

上面的命令会从 `zhaoking951-ops/dachongming` 下载安装脚本，并在新安装时拉取该仓库的代码。如果你再次 Fork 本项目，需同时替换两个仓库地址：

```bash
REPO_URL=https://github.com/YOUR_ACCOUNT/YOUR_REPO.git bash <(curl -fsSL https://raw.githubusercontent.com/YOUR_ACCOUNT/YOUR_REPO/main/install.sh)
```

### 已有安装更新

先备份 `.env`、数据库与 `data/`、`backups/` 和节点配置，并检查 `git status`。安装脚本会将已跟踪的代码文件重置为 `origin/main`，请先保存本地代码改动。

已有安装不会根据 `REPO_URL` 自动改变更新来源。从上游或旧仓库名切换时，在安装目录中设置新的 `origin`，再运行当前安装脚本：

```bash
cd /root/panel && \
git remote set-url origin https://github.com/zhaoking951-ops/dachongming.git && \
bash <(curl -fsSL https://raw.githubusercontent.com/zhaoking951-ops/dachongming/main/install.sh)
```

更新后可用 `pm2 status`、`pm2 logs vless-panel` 与 `curl -fsS http://127.0.0.1:3000/healthz` 检查服务。若手动修改了监听端口，健康检查地址也需相应调整。

### 手动部署

先安装 Git、Node.js 22、原生依赖构建工具和 PM2。使用与 `ecosystem.config.js` 一致的 `/root/panel` 目录；手动部署还需自行配置域名、Nginx 和 HTTPS。

```bash
git clone https://github.com/zhaoking951-ops/dachongming.git /root/panel
cd /root/panel
npm install --omit=dev
cp .env.example .env
# 编辑 .env，至少填 PANEL_DOMAIN 和 SESSION_SECRET
pm2 start ecosystem.config.js
pm2 save
```

## 配置

`.env` 关键变量（完整列表见 [`.env.example`](./.env.example)）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `PANEL_DOMAIN` | ✅ | 面板域名（用于 CSRF Origin 校验、订阅链接生成） |
| `SESSION_SECRET` | ✅ | 会话密钥，建议 64 字符随机字符串 |
| `PORT` | | 监听端口（默认 3000） |
| `TG_BOT_TOKEN` | | Telegram Bot Token（不填则禁用 TG 功能） |
| `OPS_API_KEY` | | OPS API Bearer Token（不填则 OPS API 不可用） |
| `SUB_LINK_SIGN_MODE` | | 订阅签名（`off` / `observe` / `enforce`） |
| `TRUST_PROXY` | | Nginx/Cloudflare 反代信任层数（默认 `1`） |
| `REALITY_SNI` | | VLESS Reality 默认 target/serverName，默认 `www.bing.com`，只填域名，target 使用 443 |

Reality 的部署、配置同步和各类订阅共用同一默认值：节点保存的 SNI 优先，其次使用 `REALITY_SNI`，最后回退到 `www.bing.com`。新部署会把选定 SNI 保存到节点；修改环境变量不会覆盖已有节点。切换已有节点的 target 前应验证目标的 TLS/Reality 兼容性，并同步服务端和客户端配置。

生成强随机密钥：

```bash
openssl rand -hex 32
```

## 项目结构

```
src/
├── app.js                  # 入口（Express + Session + Helmet + 定时任务）
├── routes/                 # 路由
│   ├── auth.js             # 登录注册
│   ├── panel.js            # 用户面板
│   ├── subscription.js     # 订阅分发
│   ├── opsApi.js           # OPS API
│   ├── monitorApi.js       # 探针
│   ├── flipGame.js / rpsGame.js / luckyWheel.js
│   └── admin/              # 管理后台路由
├── services/               # 业务逻辑
│   ├── database.js         # SQLite + 迁移
│   ├── deploy.js           # 节点部署
│   ├── aws.js              # AWS EC2/Lightsail
│   ├── health.js           # 健康检查 + 流量上报
│   ├── tgbot.js            # Telegram Bot
│   ├── agent-ws.js         # Agent WebSocket
│   ├── notify.js           # 通知分发
│   └── repos/              # 数据访问层
├── middleware/             # auth, csrf, rateLimit, errorHandler
└── utils/                  # crypto, password, time, vless, regions...

views/                      # EJS 模板
public/                     # 静态资源（CSS/JS）
test/                       # 单元测试 (node --test)
node-agent/                 # 节点 Agent
templates/                  # 部署脚本模板
openclaw-ops/               # OpenClaw AI 运维 workspace（可选）
```

## 文档

- [管理后台指南](./ADMIN-GUIDE.md) — 各模块功能说明
- [API 参考](./README-API.md) — OPS API / 用户 API / TG WebApp API
- [部署检查清单](./DEPLOY-CHECKLIST.md) — 上线前逐项确认
- [更新日志](./CHANGELOG.md)
- [节点 Agent](./node-agent/README.md)
- [OpenClaw 运维](./openclaw-ops/README.md)（可选）
- [时间显示约定](./TIME-DISPLAY-CONVENTION.md)

## 技术栈

- **运行时**：Node.js 20+（新部署建议使用 22）
- **框架**：Express 5
- **数据库**：better-sqlite3（同步 API + WAL 模式）
- **进程管理**：PM2
- **模板**：EJS
- **样式**：Tailwind CSS（预编译）
- **AWS SDK**：v3（按需加载 EC2 / Lightsail）
- **WebSocket**：ws（面板侧）+ 自实现协议（Agent 侧，避免依赖）

## 安全特性

- Helmet + 严格 CSP + 每请求随机 nonce
- CSRF 双重防护（Origin + Token）
- 登录限流 + 验证码次数限制
- 密码使用 scrypt 哈希（参数范围限制防 DoS）
- AWS 凭据 AES-256-GCM 加密存储
- 订阅链接 HMAC 签名（可选）
- 多层 Rate Limiting（IP / Token / 行为）
- Timing-safe 比较防时序攻击

## 测试

AWS 账号配置、区域筛选与升级注意事项见[管理后台指南的 AWS 章节](./ADMIN-GUIDE.md#aws)。填写账号凭据后默认自动发现实例所在区域，支持多区域，无需预先填写区域。每个账号可选择查询 EC2、Lightsail 或两者；仅使用 EC2 时可关闭 Lightsail 查询。升级自动补建账号表并保留已有数据；以前保存的手动区域筛选可在页面切回「自动发现」。

```bash
npm test
```

## License

[MIT](./LICENSE)

## 致谢

感谢上游项目 [vzzoxo/xiaoyizi](https://github.com/vzzoxo/xiaoyizi) 的作者与贡献者提供基础实现，也感谢所有反馈问题的使用者。

“大聪明”是基于上游维护的公开衍生版本，沿用 [MIT 许可证](./LICENSE) 并保留原版权声明。
