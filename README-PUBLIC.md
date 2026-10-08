# 大聪明

面向个人或小团队的多协议代理管理面板，把用户、节点、订阅、流量、运维放进同一套系统。

基于 [vzzoxo/xiaoyizi](https://github.com/vzzoxo/xiaoyizi) 修改维护，感谢上游作者与贡献者。当前公开仓库：[zhaoking951-ops/dacongming](https://github.com/zhaoking951-ops/dacongming)。

## 核心能力

- VLESS Reality / Shadowsocks / Hysteria 2 多协议
- 邮箱注册登录，用户分组与流量配额
- 智能订阅分发，自动识别客户端
- 一键部署节点，AWS 集成换 IP
- Telegram Bot 签到 / 大转盘 / 翻卡 / 猜拳
- 探针实时性能监控
- 自动化运维（被墙检测、自动换 IP、密钥轮换、不活跃冻结）
- OpenClaw AI 自动巡检（可选）

## 安装

```bash
REPO_URL=https://github.com/zhaoking951-ops/dacongming.git bash <(curl -fsSL https://raw.githubusercontent.com/zhaoking951-ops/dacongming/main/install.sh)
```

请使用 root 用户在 Debian/Ubuntu VPS 上运行，并提前配置域名解析与 TCP 80/443 端口。已有安装切换仓库前先备份数据并设置 `origin`，详见[更新说明](./README.md#已有安装更新)。

## 文档

- [完整说明](./README.md)
- [管理后台](./ADMIN-GUIDE.md)
- [API 参考](./README-API.md)
- [部署检查清单](./DEPLOY-CHECKLIST.md)

## License

[MIT](./LICENSE)，保留上游版权声明。
