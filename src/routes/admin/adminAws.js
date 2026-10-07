const express = require('express');
const db = require('../../services/database');
const aws = require('../../services/aws');
const deployService = require('../../services/deploy');
const { notify } = require('../../services/notify');
const logger = require('../../services/logger');
const { parseIntId } = require('../../utils/validators');
const { asyncHandler } = require('../../utils/asyncHandler');

const router = express.Router();

// AWS 实例缓存
let _awsInstancesCache = { data: null, ts: 0 };
let _awsCacheRevision = 0;
let _awsInstancesPending = null;

function invalidateAwsInstances() {
  _awsCacheRevision += 1;
  _awsInstancesCache = { data: null, ts: 0 };
  _awsInstancesPending = null;
}

function validateRegion(value) {
  return typeof value === 'string' && aws.ALL_AWS_REGIONS.includes(value);
}

function parseSocks5Url(socks5Url) {
  if (!socks5Url) return { host: null, port: 1080, user: null, pass: null };
  const u = new URL(socks5Url);
  if (!['socks5:', 'socks:'].includes(u.protocol)) throw new Error('仅支持 socks5:// 或 socks://');
  if (!u.hostname || !u.port) throw new Error('请包含主机和端口');
  return {
    host: u.hostname,
    port: parseInt(u.port) || 1080,
    user: u.username ? decodeURIComponent(u.username) : null,
    pass: u.password ? decodeURIComponent(u.password) : null
  };
}

router.get('/aws/config', (req, res) => {
  const accounts = db.getAwsAccounts();
  res.json({
    configured: accounts.length > 0,
    count: accounts.length,
    accounts: accounts.map(a => ({
      id: a.id, name: a.name, defaultRegion: a.default_region,
      socks5_host: a.socks5_host, socks5_port: a.socks5_port,
      enabled: !!a.enabled,
      accessKeyMasked: a.access_key ? a.access_key.substring(0, 4) + '***' + a.access_key.slice(-4) : ''
    }))
  });
});

router.post('/aws/config', (req, res) => {
  const { name, accessKey, secretKey, socks5Url, defaultRegion = 'us-east-1' } = req.body || {};
  if (!name || !accessKey || !secretKey) {
    return res.status(400).json({ error: '请填写账号名、Access Key、Secret Key' });
  }
  if (!validateRegion(defaultRegion)) return res.status(400).json({ error: '请选择有效的 AWS 默认区域' });
  let socks = { host: null, port: 1080, user: null, pass: null };
  try { socks = parseSocks5Url(socks5Url); } catch (e) {
    return res.status(400).json({ error: `SOCKS5 URL 格式错误: ${e.message}` });
  }
  aws.setAwsConfig({
    name, accessKey, secretKey, defaultRegion,
    socks5Host: socks.host, socks5Port: socks.port, socks5User: socks.user, socks5Pass: socks.pass
  });
  invalidateAwsInstances();
  db.addAuditLog(req.user.id, 'aws_config', `新增 AWS 账号: ${name}`, req.clientIp || req.ip);
  res.json({ ok: true });
});

router.put('/aws/config/:id', (req, res) => {
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const current = db.getAwsAccountById(id);
  if (!current) return res.status(404).json({ error: '账号不存在' });
  const { name, socks5Url, defaultRegion } = req.body || {};
  const updates = { name: name || current.name };
  if (defaultRegion !== undefined) {
    if (!validateRegion(defaultRegion)) return res.status(400).json({ error: '请选择有效的 AWS 默认区域' });
    updates.default_region = defaultRegion;
  }
  if (socks5Url !== undefined) {
    let socks;
    try {
      socks = socks5Url === '' ? { host: null, port: 1080, user: null, pass: null } : parseSocks5Url(socks5Url);
    } catch (e) {
      return res.status(400).json({ error: `SOCKS5 URL 格式错误: ${e.message}` });
    }
    Object.assign(updates, { socks5_host: socks.host, socks5_port: socks.port, socks5_user: socks.user, socks5_pass: socks.pass });
  }
  db.updateAwsAccount(id, updates);
  invalidateAwsInstances();
  db.addAuditLog(req.user.id, 'aws_config_edit', `编辑 AWS 账号 #${id}`, req.clientIp || req.ip);
  res.json({ ok: true });
});

router.delete('/aws/config/:id', (req, res) => {
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  db.deleteAwsAccount(id);
  invalidateAwsInstances();
  db.addAuditLog(req.user.id, 'aws_config_delete', `删除 AWS 账号 #${id}`, req.clientIp || req.ip);
  res.json({ ok: true });
});

router.post('/aws/socks-test', async (req, res) => {
  const { socks5Url } = req.body || {};
  if (!socks5Url) return res.status(400).json({ error: '请填写 SOCKS5 URL' });
  let url;
  try {
    url = new URL(socks5Url);
    if (!['socks5:', 'socks:'].includes(url.protocol)) throw new Error('仅支持 socks5:// 或 socks://');
    if (!url.hostname || !url.port) throw new Error('请包含主机和端口');
  } catch (e) {
    return res.status(400).json({ error: `SOCKS5 URL 格式错误: ${e.message}` });
  }
  try {
    const https = require('https');
    const { SocksProxyAgent } = require('socks-proxy-agent');
    const agent = new SocksProxyAgent(socks5Url);
    const ip = await new Promise((resolve, reject) => {
      const r = https.get('https://api.ipify.org?format=json', { agent, timeout: 12000 }, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => {
          try { const j = JSON.parse(data || '{}'); if (!j.ip) return reject(new Error('未获取到出口 IP')); resolve(j.ip); }
          catch { reject(new Error('返回格式异常')); }
        });
      });
      r.on('timeout', () => r.destroy(new Error('连接超时')));
      r.on('error', reject);
    });
    res.json({ ok: true, ip });
  } catch (e) {
    res.status(500).json({ error: '代理验证失败' });
  }
});

router.get('/aws/instances', async (req, res) => {
  const region = req.query.region || undefined;
  const type = req.query.type || 'ec2';
  const accountId = parseInt(req.query.accountId) || undefined;
  try {
    const instances = type === 'lightsail'
      ? await aws.listLightsailInstances(region, accountId)
      : await aws.listEC2Instances(region, accountId);
    res.json(instances);
  } catch (e) { res.status(500).json({ error: '获取实例列表失败' }); }
});

router.post('/nodes/:id/aws-bind', asyncHandler(async (req, res) => {
  const { aws_instance_id, aws_type, aws_region, aws_account_id } = req.body;
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const node = db.getNodeById(id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  db.updateNode(node.id, {
    aws_instance_id: aws_instance_id || null, aws_type: aws_type || 'ec2',
    aws_region: aws_region || null, aws_account_id: aws_account_id ? parseInt(aws_account_id) : null
  });
  if (aws_instance_id) {
    try { await aws.tagInstance(aws_instance_id, { Name: node.name }, aws_type || 'ec2', aws_region, aws_account_id ? parseInt(aws_account_id) : undefined); }
    catch (e) { logger.warn({ err: e, instanceId: aws_instance_id }, '[AWS绑定] 打标签失败'); }
  }
  db.addAuditLog(req.user.id, 'aws_bind', `绑定 AWS: ${node.name} → ${aws_instance_id} (${aws_type}) [账号:${aws_account_id || '默认'}]`, req.clientIp || req.ip);
  res.json({ ok: true });
}));

router.post('/nodes/:id/swap-ip', async (req, res) => {
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const node = db.getNodeById(id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  if (!node.aws_instance_id) return res.status(400).json({ error: '节点未绑定 AWS 实例' });
  db.addAuditLog(req.user.id, 'aws_swap_ip', `手动换 IP: ${node.name}`, req.clientIp || req.ip);
  try {
    const result = await aws.swapNodeIp(node, node.aws_instance_id, node.aws_type, node.aws_region, node.aws_account_id);
    if (result.success) { notify.ops(`🔄 ${node.name} 手动换 IP: ${result.oldIp} → ${result.newIp}`).catch(() => {}); }
    res.json(result);
  } catch (e) { res.status(500).json({ error: '换 IP 失败' }); }
});

router.get('/aws/all-instances', async (req, res) => {
  const force = req.query.force === '1';
  try {
    if (!force && _awsInstancesCache.data && Date.now() - _awsInstancesCache.ts < 600000) {
      return res.json(_awsInstancesCache.data);
    }
    const revision = _awsCacheRevision;
    if (!_awsInstancesPending) {
      const pending = aws.listAllInstances();
      _awsInstancesPending = pending;
      pending.finally(() => {
        if (_awsInstancesPending === pending) _awsInstancesPending = null;
      }).catch(() => {});
    }
    const results = await _awsInstancesPending;
    // 配置变更前发出的请求不能重新填充缓存，失败/部分失败也不能缓存为成功。
    if (revision === _awsCacheRevision) {
      _awsInstancesCache = results.every(a => !a.errors?.length)
        ? { data: results, ts: Date.now() } : { data: null, ts: 0 };
    }
    res.json(results);
  } catch (e) {
    _awsInstancesCache = { data: null, ts: 0 };
    res.status(500).json({ error: '获取全部实例失败' });
  }
});

// 获取所有 AWS 区域元信息和当前启用列表
router.get('/aws/regions', (req, res) => {
  const enabled = aws.getEnabledRegions();
  res.json({
    all: aws.ALL_AWS_REGIONS,
    meta: aws.AWS_REGION_META,
    enabled: enabled || [],
    autoDiscover: enabled === null,
  });
});

// 保存启用的区域列表
router.post('/aws/regions', (req, res) => {
  const { regions } = req.body || {};
  if (regions !== null && (!Array.isArray(regions) || !regions.every(validateRegion))) {
    return res.status(400).json({ error: '参数 regions 必须为有效区域数组，或 null（自动发现）' });
  }
  const valid = regions === null ? null : [...new Set(regions)];
  db.setSetting('aws_enabled_regions', JSON.stringify(valid));
  // 清缓存让下次刷新立即生效
  invalidateAwsInstances();
  db.addAuditLog(req.user.id, 'aws_enabled_regions', `更新启用区域: ${valid === null ? '自动发现' : valid.length + ' 个'}`, req.clientIp || req.ip);
  res.json({ ok: true, count: valid?.length || 0, autoDiscover: valid === null });
});

router.post('/aws/start', async (req, res) => {
  const { instanceId, region, type, accountId } = req.body;
  if (!instanceId) return res.status(400).json({ error: '缺少 instanceId' });
  try {
    if (type === 'lightsail') await aws.startLightsailInstance(instanceId, region, accountId ? parseInt(accountId) : undefined);
    else await aws.startEC2Instance(instanceId, region, accountId ? parseInt(accountId) : undefined);
    db.addAuditLog(req.user.id, 'aws_start', `开机: ${instanceId} (${type})`, req.clientIp || req.ip);
    res.json({ ok: true });
  } catch (e) { logger.error({ err: e }, 'AWS 开机失败'); res.status(500).json({ error: '开机操作失败' }); }
});

router.post('/aws/stop', async (req, res) => {
  const { instanceId, region, type, accountId } = req.body;
  if (!instanceId) return res.status(400).json({ error: '缺少 instanceId' });
  try {
    if (type === 'lightsail') await aws.stopLightsailInstance(instanceId, region, accountId ? parseInt(accountId) : undefined);
    else await aws.stopEC2Instance(instanceId, region, accountId ? parseInt(accountId) : undefined);
    db.addAuditLog(req.user.id, 'aws_stop', `关机: ${instanceId} (${type})`, req.clientIp || req.ip);
    res.json({ ok: true });
  } catch (e) { logger.error({ err: e }, 'AWS 关机失败'); res.status(500).json({ error: '关机操作失败' }); }
});

router.post('/aws/terminate', async (req, res) => {
  const { instanceId, region, type, accountId } = req.body;
  if (!instanceId) return res.status(400).json({ error: '缺少 instanceId' });
  try {
    if (type === 'lightsail') await aws.terminateLightsailInstance(instanceId, region, accountId ? parseInt(accountId) : undefined);
    else await aws.terminateEC2Instance(instanceId, region, accountId ? parseInt(accountId) : undefined);
    db.addAuditLog(req.user.id, 'aws_terminate', `终止实例: ${instanceId} (${type})`, req.clientIp || req.ip);
    res.json({ ok: true });
  } catch (e) { logger.error({ err: e }, 'AWS 终止实例失败'); res.status(500).json({ error: '终止实例失败' }); }
});

router.post('/aws/swap-ip', async (req, res) => {
  const { instanceId, type, region, accountId } = req.body;
  if (!instanceId) return res.status(400).json({ error: '缺少 instanceId' });
  const allNodes = db.getAllNodes();
  const node = allNodes.find(n => n.aws_instance_id === instanceId);
  try {
    if (node) {
      const result = await aws.swapNodeIp(node, instanceId, type, region, accountId ? parseInt(accountId) : undefined);
      res.json(result);
    } else {
      let result;
      if (type === 'lightsail') result = await aws.swapLightsailIp(instanceId, region, accountId ? parseInt(accountId) : undefined);
      else result = await aws.swapEC2Ip(instanceId, region, accountId ? parseInt(accountId) : undefined);
      db.addAuditLog(req.user.id, 'aws_swap_ip', `换IP: ${instanceId} ${result.oldIp} → ${result.newIp}`, req.clientIp || req.ip);
      res.json({ success: true, newIp: result.newIp, oldIp: result.oldIp });
    }
  } catch (e) { logger.error({ err: e }, 'AWS 换 IP 失败'); res.status(500).json({ error: '换 IP 操作失败' }); }
});

router.post('/aws/launch-and-deploy', async (req, res) => {
  const { accountId, region, type, spec, sshPassword } = req.body;
  if (!accountId || !region || !type) return res.status(400).json({ error: '参数不完整' });
  if (!sshPassword) return res.status(400).json({ error: '请填写 SSH 密码（用于部署）' });

  res.json({ ok: true, message: '创建中...' });

  try {
    db.addAuditLog(req.user.id, 'aws_launch', `开始创建: ${type} ${spec} in ${region} (账号#${accountId})`, req.clientIp || req.ip);

    let instanceId;
    if (type === 'lightsail') {
      const name = `panel-${Date.now()}`;
      await aws.launchLightsailInstance(region, spec, name, parseInt(accountId));
      instanceId = name;
    } else {
      const result = await aws.launchEC2Instance(region, spec, parseInt(accountId));
      instanceId = result.instanceId;
    }
    logger.info({ instanceId, type, region, accountId: parseInt(accountId) }, '[一键部署] 实例已创建');

    const inst = await aws.waitForInstanceRunning(instanceId, type, region, parseInt(accountId));
    const publicIp = inst.publicIp || inst.publicIpAddress;
    logger.info({ instanceId, publicIp, type, region, accountId: parseInt(accountId) }, '[一键部署] 实例就绪');
    if (!publicIp) throw new Error('实例无公网 IP');

    const { checkPort } = require('../../services/health');
    let sshReady = false;
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5000));
      sshReady = await checkPort(publicIp, 22, 5000);
      if (sshReady) break;
    }
    if (!sshReady) throw new Error('SSH 120秒内未就绪');

    await deployService.deployNode({
      host: publicIp, ssh_password: sshPassword, ssh_port: 22,
      ssh_user: type === 'lightsail' ? 'ubuntu' : 'root',
      triggered_by: req.user.id
    }, db);

    const allNodes = db.getAllNodes();
    const newNode = allNodes.find(n => n.host === publicIp);
    if (newNode) {
      db.updateNode(newNode.id, { aws_instance_id: instanceId, aws_type: type, aws_region: region, aws_account_id: parseInt(accountId) });
      try { await aws.tagInstance(instanceId, { Name: newNode.name }, type, region, parseInt(accountId)); }
      catch (e) { logger.warn({ err: e, instanceId, nodeId: newNode.id }, '[一键部署] 打标签失败'); }
    }

    db.addAuditLog(req.user.id, 'aws_launch_done', `一键部署完成: ${instanceId} IP: ${publicIp}`, req.clientIp || req.ip);
    notify.ops(`🚀 一键部署完成: ${instanceId} (${publicIp})`).catch((err) => {
      logger.debug({ err, instanceId }, '发送一键部署成功通知失败，已忽略');
    });
  } catch (e) {
    logger.error(`[一键部署] 失败: ${e.message}`);
    db.addAuditLog(req.user.id, 'aws_launch_fail', `一键部署失败: ${e.message}`, req.clientIp || req.ip);
    notify.ops(`❌ 一键部署失败: ${e.message}`).catch((err) => {
      logger.debug({ err, error: e.message }, '发送一键部署失败通知失败，已忽略');
    });
  }
});

// 自动绑定：根据节点 IP 匹配 AWS 实例
router.post('/aws/auto-bind', asyncHandler(async (req, res) => {
  const allInstances = await aws.listAllInstances();
  const allNodes = db.getAllNodes();
  const unboundNodes = allNodes.filter(n => !n.aws_instance_id && n.protocol !== 'hy2');
  if (!unboundNodes.length) return res.json({ ok: true, bound: 0, details: [] });

  // 构建 IP → 实例映射
  const ipMap = new Map();
  for (const account of allInstances) {
    for (const inst of account.instances) {
      if (inst.publicIp && inst.state === 'running') {
        ipMap.set(inst.publicIp, {
          instanceId: inst.instanceId || inst.instanceName,
          type: inst.instanceType === 'lightsail' ? 'lightsail' : 'ec2',
          region: inst.region,
          accountId: inst.accountId,
        });
      }
    }
  }

  const details = [];
  for (const node of unboundNodes) {
    const match = ipMap.get(node.host) || ipMap.get(node.ssh_host);
    if (!match) continue;
    db.updateNode(node.id, {
      aws_instance_id: match.instanceId,
      aws_type: match.type,
      aws_region: match.region,
      aws_account_id: match.accountId,
    });
    try { await aws.tagInstance(match.instanceId, { Name: node.name }, match.type, match.region, match.accountId); } catch (_) {}
    details.push({ nodeId: node.id, nodeName: node.name, instanceId: match.instanceId });
    db.addAuditLog(req.user.id, 'aws_auto_bind', `自动绑定: ${node.name} → ${match.instanceId}`, req.clientIp || req.ip);
  }

  res.json({ ok: true, bound: details.length, details });
}));

module.exports = router;
