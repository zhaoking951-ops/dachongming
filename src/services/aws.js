const { EC2Client, DescribeRegionsCommand, DescribeInstancesCommand, AllocateAddressCommand, AssociateAddressCommand, DisassociateAddressCommand, ReleaseAddressCommand, DescribeAddressesCommand, RunInstancesCommand, TerminateInstancesCommand, StartInstancesCommand, StopInstancesCommand, DescribeImagesCommand, CreateTagsCommand } = require('@aws-sdk/client-ec2');
const { LightsailClient, GetRegionsCommand, GetInstancesCommand, GetStaticIpsCommand, AllocateStaticIpCommand, AttachStaticIpCommand, DetachStaticIpCommand, ReleaseStaticIpCommand, CreateInstancesCommand, DeleteInstanceCommand, StartInstanceCommand, StopInstanceCommand } = require('@aws-sdk/client-lightsail');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { SocksProxyAgent } = require('socks-proxy-agent');
const db = require('./database');
const logger = require('./logger');
const { encrypt, decrypt } = require('../utils/crypto');

// ========== AWS 区域常量 ==========

// 所有支持的 AWS 商用区域（按地理分组），用于实例查询
const ALL_AWS_REGIONS = [
  // 美洲
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'ca-central-1', 'ca-west-1',
  'mx-central-1',
  'sa-east-1',
  // 欧洲
  'eu-west-1', 'eu-west-2', 'eu-west-3',
  'eu-central-1', 'eu-central-2',
  'eu-north-1',
  'eu-south-1', 'eu-south-2',
  // 亚太
  'ap-east-1', 'ap-east-2',
  'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
  'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4', 'ap-southeast-5', 'ap-southeast-7',
  'ap-south-1', 'ap-south-2',
  // 中东与非洲
  'me-south-1', 'me-central-1',
  'il-central-1',
  'af-south-1',
];

// Lightsail 支持的区域（子集），需要单独维护
// 参考 https://docs.aws.amazon.com/general/latest/gr/lightsail.html
const LIGHTSAIL_REGIONS = new Set([
  'us-east-1', 'us-east-2', 'us-west-2',
  'ca-central-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1',
  'ap-northeast-1', 'ap-northeast-2',
  'ap-south-1',
  'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-5',
]);

// 区域元信息：分组 + 中文名（供前端展示）
const AWS_REGION_META = {
  'us-east-1':      { group: '美洲',     name: '弗吉尼亚 N.', lightsail: true  },
  'us-east-2':      { group: '美洲',     name: '俄亥俄',       lightsail: true  },
  'us-west-1':      { group: '美洲',     name: '北加州',       lightsail: false },
  'us-west-2':      { group: '美洲',     name: '俄勒冈',       lightsail: true  },
  'ca-central-1':   { group: '美洲',     name: '加拿大中部',   lightsail: true  },
  'ca-west-1':      { group: '美洲',     name: '加拿大西部',   lightsail: false },
  'mx-central-1':   { group: '美洲',     name: '墨西哥',       lightsail: false },
  'sa-east-1':      { group: '美洲',     name: '圣保罗',       lightsail: false },
  'eu-west-1':      { group: '欧洲',     name: '爱尔兰',       lightsail: true  },
  'eu-west-2':      { group: '欧洲',     name: '伦敦',         lightsail: true  },
  'eu-west-3':      { group: '欧洲',     name: '巴黎',         lightsail: true  },
  'eu-central-1':   { group: '欧洲',     name: '法兰克福',     lightsail: true  },
  'eu-central-2':   { group: '欧洲',     name: '苏黎世',       lightsail: false },
  'eu-north-1':     { group: '欧洲',     name: '斯德哥尔摩',   lightsail: true  },
  'eu-south-1':     { group: '欧洲',     name: '米兰',         lightsail: false },
  'eu-south-2':     { group: '欧洲',     name: '西班牙',       lightsail: false },
  'ap-east-1':      { group: '亚太',     name: '香港',         lightsail: false },
  'ap-east-2':      { group: '亚太',     name: '台北',         lightsail: false },
  'ap-northeast-1': { group: '亚太',     name: '东京',         lightsail: true  },
  'ap-northeast-2': { group: '亚太',     name: '首尔',         lightsail: true  },
  'ap-northeast-3': { group: '亚太',     name: '大阪',         lightsail: false },
  'ap-southeast-1': { group: '亚太',     name: '新加坡',       lightsail: true  },
  'ap-southeast-2': { group: '亚太',     name: '悉尼',         lightsail: true  },
  'ap-southeast-3': { group: '亚太',     name: '雅加达',       lightsail: true  },
  'ap-southeast-4': { group: '亚太',     name: '墨尔本',       lightsail: false },
  'ap-southeast-5': { group: '亚太',     name: '吉隆坡',       lightsail: true  },
  'ap-southeast-7': { group: '亚太',     name: '曼谷',         lightsail: false },
  'ap-south-1':     { group: '亚太',     name: '孟买',         lightsail: true  },
  'ap-south-2':     { group: '亚太',     name: '海得拉巴',     lightsail: false },
  'me-south-1':     { group: '中东与非洲', name: '巴林',       lightsail: false },
  'me-central-1':   { group: '中东与非洲', name: '阿联酋',     lightsail: false },
  'il-central-1':   { group: '中东与非洲', name: '以色列',     lightsail: false },
  'af-south-1':     { group: '中东与非洲', name: '开普敦',     lightsail: false },
};

// ========== 配置管理 ==========

function getAwsConfig(accountId) {
  if (accountId) {
    const a = db.getAwsAccountById(accountId);
    if (!a || !a.enabled) return null;
    return {
      accountId: a.id,
      name: a.name,
      accessKey: a.access_key,
      secretKey: a.secret_key,
      defaultRegion: a.default_region || 'us-east-1',
      socks5_host: a.socks5_host,
      socks5_port: a.socks5_port || 1080,
      socks5_user: a.socks5_user,
      socks5_pass: a.socks5_pass
    };
  }

  // 向后兼容旧版单账号 settings
  const accessKey = decrypt(db.getSetting('aws_access_key') || '');
  const secretKey = decrypt(db.getSetting('aws_secret_key') || '');
  const defaultRegion = db.getSetting('aws_default_region') || 'us-east-1';
  if (!accessKey || !secretKey) return null;
  return { accessKey, secretKey, defaultRegion };
}

function setAwsConfig(cfg) {
  if (!cfg.name) {
    // 保留旧版入口：写入 settings
    if (cfg.accessKey) db.setSetting('aws_access_key', encrypt(cfg.accessKey));
    if (cfg.secretKey) db.setSetting('aws_secret_key', encrypt(cfg.secretKey));
    if (cfg.defaultRegion) db.setSetting('aws_default_region', cfg.defaultRegion);
    return;
  }

  // 新版：写入 aws_accounts
  return db.addAwsAccount({
    name: cfg.name,
    access_key: cfg.accessKey,
    secret_key: cfg.secretKey,
    default_region: cfg.defaultRegion || 'us-east-1',
    socks5_host: cfg.socks5Host,
    socks5_port: cfg.socks5Port || 1080,
    socks5_user: cfg.socks5User,
    socks5_pass: cfg.socks5Pass,
    enabled: true
  });
}

function buildRequestHandler(cfg) {
  if (!cfg?.socks5_host) return undefined;
  const auth = cfg.socks5_user ? `${encodeURIComponent(cfg.socks5_user)}:${encodeURIComponent(cfg.socks5_pass || '')}@` : '';
  const proxyUrl = `socks5://${auth}${cfg.socks5_host}:${cfg.socks5_port || 1080}`;
  return new NodeHttpHandler({
    httpAgent: new SocksProxyAgent(proxyUrl),
    httpsAgent: new SocksProxyAgent(proxyUrl)
  });
}

function getEC2Client(region, accountId) {
  const cfg = getAwsConfig(accountId);
  if (!cfg) throw new Error('AWS 未配置');
  return new EC2Client({
    region: region || cfg.defaultRegion,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    requestHandler: buildRequestHandler(cfg)
  });
}

function getLightsailClient(region, accountId) {
  const cfg = getAwsConfig(accountId);
  if (!cfg) throw new Error('AWS 未配置');
  return new LightsailClient({
    region: region || cfg.defaultRegion,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    requestHandler: buildRequestHandler(cfg)
  });
}

// ========== EC2 操作 ==========

// 解析 EC2 实例公网 IP（兼容普通/Wavelength）
function resolveEc2PublicIp(instance) {
  const assoc = instance.NetworkInterfaces?.[0]?.Association;
  return instance.PublicIpAddress || assoc?.PublicIp || assoc?.CarrierIp || null;
}

// 列出实例
async function listEC2Instances(region, accountId, sendOptions = {}) {
  const ec2 = getEC2Client(region, accountId);
  try {
    const instances = [];
    const missingIpIds = [];
    let nextToken;
    do {
      const res = await ec2.send(new DescribeInstancesCommand({ NextToken: nextToken }), sendOptions);
      for (const r of res.Reservations || []) {
        for (const i of r.Instances || []) {
          const nameTag = (i.Tags || []).find(t => t.Key === 'Name');
          const az = i.Placement?.AvailabilityZone || '';
          const publicIp = resolveEc2PublicIp(i);
          instances.push({
            instanceId: i.InstanceId, name: nameTag?.Value || '', state: i.State?.Name,
            publicIp, privateIp: i.PrivateIpAddress, type: i.InstanceType,
            region: region || getAwsConfig(accountId)?.defaultRegion, launchTime: i.LaunchTime,
            isWavelength: az.includes('-wl'),
            networkInterfaceId: i.NetworkInterfaces?.[0]?.NetworkInterfaceId, availabilityZone: az
          });
          if (i.InstanceId && !publicIp) missingIpIds.push(i.InstanceId);
        }
      }
      nextToken = res.NextToken;
    } while (nextToken);

    // 补查 EIP 是可选操作；不影响实例列表，但刷新超时仍应向上传播。
    if (missingIpIds.length) {
      try {
        const addrRes = await ec2.send(new DescribeAddressesCommand({
          Filters: [{ Name: 'instance-id', Values: missingIpIds }]
        }), sendOptions);
        const eipMap = new Map();
        for (const addr of addrRes.Addresses || []) {
          if (addr.InstanceId) eipMap.set(addr.InstanceId, addr.PublicIp || addr.CarrierIp);
        }
        for (const inst of instances) {
          if (!inst.publicIp && eipMap.has(inst.instanceId)) inst.publicIp = eipMap.get(inst.instanceId);
        }
      } catch (err) {
        if (sendOptions.abortSignal?.aborted) throw err;
      }
    }
    return instances;
  } finally {
    ec2.destroy();
  }
}

// 换 IP（EC2 弹性 IP）：释放旧 EIP → 分配新 EIP → 绑定
// 自动检测 Wavelength 实例，使用 Carrier IP 路径
async function swapEC2Ip(instanceId, region, accountId) {
  const ec2 = getEC2Client(region, accountId);

  // 0. 查询实例信息，判断是否 Wavelength
  const descRes = await ec2.send(new DescribeInstancesCommand({
    InstanceIds: [instanceId]
  }));
  const inst = descRes.Reservations?.[0]?.Instances?.[0];
  if (!inst) throw new Error('实例不存在: ' + instanceId);
  const az = inst.Placement?.AvailabilityZone || '';
  const isWavelength = az.includes('-wl');
  const networkInterfaceId = inst.NetworkInterfaces?.[0]?.NetworkInterfaceId;

  if (isWavelength) {
    // ===== Wavelength 路径：使用 Carrier IP =====
    if (!networkInterfaceId) throw new Error('Wavelength 实例无网络接口');
    const eniPrivateIp = inst.NetworkInterfaces?.[0]?.PrivateIpAddress || undefined;
    const oldCarrierIp = inst.NetworkInterfaces?.[0]?.Association?.CarrierIp;

    // 1. 查找当前绑定的旧 EIP
    const addrRes = await ec2.send(new DescribeAddressesCommand({
      Filters: [{ Name: 'network-interface-id', Values: [networkInterfaceId] }]
    }));
    const oldEip = addrRes.Addresses?.[0];
    const oldAllocId = oldEip?.AllocationId;
    logger.info({ instanceId, hasOldEip: !!oldEip, allocId: oldAllocId, carrierIp: oldEip?.CarrierIp }, '[AWS-WL] 查询旧地址');

    // 2. 先分配新 EIP（Wavelength 需要 NetworkBorderGroup = AZ）
    const allocRes = await ec2.send(new AllocateAddressCommand({
      Domain: 'vpc', NetworkBorderGroup: az
    }));
    const newAllocId = allocRes.AllocationId;
    const newIp = allocRes.CarrierIp || allocRes.PublicIp;
    logger.info({ instanceId, newIp, newAllocId }, '[AWS-WL] 分配新 EIP');

    // 3. 绑定新 EIP 到网络接口（会自动顶掉旧的绑定）
    try {
      await ec2.send(new AssociateAddressCommand({
        AllocationId: newAllocId,
        NetworkInterfaceId: networkInterfaceId,
        PrivateIpAddress: eniPrivateIp
      }));
    } catch (assocErr) {
      try { await ec2.send(new ReleaseAddressCommand({ AllocationId: newAllocId })); } catch (_) {}
      throw assocErr;
    }
    logger.info({ instanceId, newIp }, '[AWS-WL] 绑定新 EIP 完成');

    // 4. 释放旧 EIP（绑定新的后旧的已自动解绑）
    if (oldAllocId) {
      // 先等 5 秒让 AWS 状态传播
      await new Promise(r => setTimeout(r, 5000));

      // 列出所有未绑定的 Wavelength EIP，逐一释放
      try {
        const allAddrs = await ec2.send(new DescribeAddressesCommand({}));
        const orphaned = (allAddrs.Addresses || []).filter(a =>
          !a.AssociationId && a.AllocationId && a.AllocationId !== newAllocId &&
          (a.CarrierIp || (a.NetworkBorderGroup && a.NetworkBorderGroup.includes('-wl')))
        );
        logger.info({ instanceId, orphanCount: orphaned.length, orphanIds: orphaned.map(a => a.AllocationId) }, '[AWS-WL] 查找未绑定的 Wavelength EIP');

        for (const addr of orphaned) {
          try {
            await ec2.send(new ReleaseAddressCommand({
              AllocationId: addr.AllocationId,
              NetworkBorderGroup: addr.NetworkBorderGroup || az
            }));
            logger.info({ instanceId, allocId: addr.AllocationId, ip: addr.CarrierIp || addr.PublicIp }, '[AWS-WL] 清理孤立 EIP 成功');
          } catch (relErr) {
            logger.warn({ instanceId, allocId: addr.AllocationId, err: relErr.message }, '[AWS-WL] 清理孤立 EIP 失败');
          }
        }
      } catch (listErr) {
        logger.warn({ instanceId, err: listErr.message }, '[AWS-WL] 列出地址失败');
      }
    }

    return { oldIp: oldEip?.CarrierIp || oldEip?.PublicIp || oldCarrierIp, newIp, allocationId: newAllocId };
  }

  // ===== 普通 EC2 路径 =====

  // 1. 查找当前绑定的弹性 IP
  const addrRes = await ec2.send(new DescribeAddressesCommand({
    Filters: [{ Name: 'instance-id', Values: [instanceId] }]
  }));
  const oldEip = addrRes.Addresses?.[0];

  // 2. 解绑并释放旧 EIP
  if (oldEip) {
    await ec2.send(new DisassociateAddressCommand({ AssociationId: oldEip.AssociationId }));
    await ec2.send(new ReleaseAddressCommand({ AllocationId: oldEip.AllocationId }));
    logger.info({ instanceId, oldIp: oldEip.PublicIp }, '[AWS] 释放旧 EIP');
  }

  // 3. 分配新 EIP
  const allocRes = await ec2.send(new AllocateAddressCommand({ Domain: 'vpc' }));
  const newIp = allocRes.PublicIp;
  const newAllocId = allocRes.AllocationId;
  logger.info({ instanceId, newIp, allocationId: newAllocId }, '[AWS] 分配新 EIP');

  // 4. 绑定到实例（失败时释放新 EIP 避免资源泄漏）
  try {
    await ec2.send(new AssociateAddressCommand({
      InstanceId: instanceId,
      AllocationId: newAllocId
    }));
  } catch (assocErr) {
    try { await ec2.send(new ReleaseAddressCommand({ AllocationId: newAllocId })); } catch (_) {}
    throw assocErr;
  }
  logger.info({ instanceId, newIp }, '[AWS] 绑定新 EIP');

  return { oldIp: oldEip?.PublicIp, newIp, allocationId: newAllocId };
}

// 终止实例
async function terminateEC2Instance(instanceId, region, accountId) {
  const ec2 = getEC2Client(region, accountId);
  await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
  return true;
}

// 启动/停止实例
async function startEC2Instance(instanceId, region, accountId) {
  const ec2 = getEC2Client(region, accountId);
  await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
  return true;
}

async function stopEC2Instance(instanceId, region, accountId) {
  const ec2 = getEC2Client(region, accountId);
  await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
  return true;
}

// ========== Lightsail 操作 ==========

// 列出 Lightsail 实例
async function listLightsailInstances(region, accountId, sendOptions = {}) {
  const ls = getLightsailClient(region, accountId);
  try {
    const instances = [];
    let pageToken;
    do {
      const res = await ls.send(new GetInstancesCommand({ pageToken }), sendOptions);
      instances.push(...(res.instances || []).map(i => ({
        instanceName: i.name, state: i.state?.name, publicIp: i.publicIpAddress,
        privateIp: i.privateIpAddress, staticIp: i.isStaticIp,
        region: i.location?.regionName || region || getAwsConfig(accountId)?.defaultRegion,
        az: i.location?.availabilityZone, blueprintId: i.blueprintId, bundleId: i.bundleId
      })));
      pageToken = res.nextPageToken;
    } while (pageToken);
    return instances;
  } finally {
    ls.destroy();
  }
}

// Lightsail 换 IP：解绑静态 IP → 释放 → 分配新的 → 绑定
async function swapLightsailIp(instanceName, region, accountId) {
  const ls = getLightsailClient(region, accountId);

  // 1. 查找当前绑定的静态 IP
  const ipsRes = await ls.send(new GetStaticIpsCommand({}));
  const oldStaticIp = (ipsRes.staticIps || []).find(ip => ip.attachedTo === instanceName);
  let oldIp = null;

  // 2. 解绑并释放旧静态 IP
  if (oldStaticIp) {
    oldIp = oldStaticIp.ipAddress;
    await ls.send(new DetachStaticIpCommand({ staticIpName: oldStaticIp.name }));
    await ls.send(new ReleaseStaticIpCommand({ staticIpName: oldStaticIp.name }));
    logger.info({ instanceName, oldIp }, '[AWS] Lightsail 释放旧 IP');
  }

  // 3. 分配新静态 IP
  const newName = `panel-${instanceName}-${Date.now()}`;
  await ls.send(new AllocateStaticIpCommand({ staticIpName: newName }));

  // 4. 绑定到实例（失败时释放新 IP 避免资源泄漏）
  try {
    await ls.send(new AttachStaticIpCommand({ staticIpName: newName, instanceName }));
  } catch (attachErr) {
    try { await ls.send(new ReleaseStaticIpCommand({ staticIpName: newName })); } catch (_) {}
    throw attachErr;
  }

  // 5. 获取新 IP 地址
  const newIpsRes = await ls.send(new GetStaticIpsCommand({}));
  const newStaticIp = (newIpsRes.staticIps || []).find(ip => ip.name === newName);
  const newIp = newStaticIp?.ipAddress;

  logger.info({ instanceName, newIp }, '[AWS] Lightsail 新 IP 绑定完成');
  return { oldIp, newIp, staticIpName: newName };
}

// ========== 节点换 IP 联动 ==========

/**
 * 节点换 IP 完整流程：
 * 1. 调用 AWS 换 IP
 * 2. 更新数据库节点记录
 * 3. 等待 SSH 可用
 * 4. 同步 xray 配置
 */
async function swapNodeIp(node, awsInstanceId, awsType, awsRegion, awsAccountId) {
  const log = [];
  const l = (msg) => {
    log.push(msg);
    logger.info({ nodeId: node?.id, nodeName: node?.name, awsInstanceId, awsType }, `[换IP] ${msg}`);
  };

  try {
    l(`开始换 IP: ${node.name} (${node.host})`);

    // 1. 换 IP
    let result;
    if (awsType === 'lightsail') {
      result = await swapLightsailIp(awsInstanceId, awsRegion, awsAccountId);
    } else {
      result = await swapEC2Ip(awsInstanceId, awsRegion, awsAccountId);
    }

    if (!result.newIp) throw new Error('未获取到新 IP');
    l(`IP 变更: ${result.oldIp} → ${result.newIp}`);

    // 2. 更新数据库（触发节点 + 同机节点）
    const oldHost = node.host;
    db.updateNode(node.id, { host: result.newIp, ssh_host: result.newIp });
    const allNodes = db.getAllNodes();
    const peerNodes = allNodes.filter(n => n.id !== node.id && (n.host === oldHost || n.ssh_host === oldHost));
    for (const peer of peerNodes) {
      const updates = { ssh_host: result.newIp };
      if (peer.host === oldHost) {
        // host 也是同一个 IPv4，一起换（如 vless、hy2）
        updates.host = result.newIp;
      }
      // host 是 IPv6 的节点（如 ss）只更新 ssh_host，不动 host
      db.updateNode(peer.id, updates);
      l(`同机节点 ${peer.name} (${peer.protocol}) ${updates.host ? 'host+' : ''}ssh_host 已更新`);
    }
    l('数据库已更新');

    // 3. 等待 SSH 可用（最多等 60 秒）
    l('等待 SSH 可用...');
    const { checkPort } = require('./health'); // 延迟加载避免循环依赖
    let sshReady = false;
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5000));
      sshReady = await checkPort(result.newIp, node.ssh_port || 22, 5000);
      if (sshReady) break;
    }

    if (!sshReady) {
      l('⚠️ SSH 60秒内未就绪，跳过配置同步');
      return { success: true, newIp: result.newIp, oldIp: result.oldIp, log: log.join('\n'), sshReady: false };
    }
    l('SSH 已就绪');

    // 4. 同步 xray 配置
    const { syncNodeConfig } = require('./deploy'); // 延迟加载避免循环依赖
    const updatedNode = db.getNodeById(node.id);
    const syncOk = await syncNodeConfig(updatedNode, db);
    if (syncOk) {
      l('✅ xray 配置已同步');
      db.updateNode(node.id, { is_active: 1, remark: '' });
    } else {
      l('⚠️ xray 配置同步失败');
    }

    // 4b. 同步同机节点的配置和状态
    for (const peer of peerNodes) {
      try {
        const updatedPeer = db.getNodeById(peer.id);
        const peerSyncOk = await syncNodeConfig(updatedPeer, db);
        if (peerSyncOk) {
          db.updateNode(peer.id, { is_active: 1, remark: '' });
          l(`✅ 同机节点 ${peer.name} 配置已同步`);
        } else {
          l(`⚠️ 同机节点 ${peer.name} 配置同步失败`);
        }
      } catch (e) {
        l(`⚠️ 同机节点 ${peer.name} 同步异常: ${e.message}`);
      }
    }

    // 5. 审计日志
    db.addAuditLog(null, 'aws_swap_ip', `${node.name} IP变更: ${result.oldIp} → ${result.newIp}`, 'system');

    return { success: true, newIp: result.newIp, oldIp: result.oldIp, log: log.join('\n'), sshReady };

  } catch (e) {
    l(`❌ 换 IP 失败: ${e.message}`);
    return { success: false, error: e.message, log: log.join('\n') };
  }
}

// ========== Lightsail 启停/终止 ==========

async function startLightsailInstance(instanceName, region, accountId) {
  const ls = getLightsailClient(region, accountId);
  await ls.send(new StartInstanceCommand({ instanceName }));
  return true;
}

async function stopLightsailInstance(instanceName, region, accountId) {
  const ls = getLightsailClient(region, accountId);
  await ls.send(new StopInstanceCommand({ instanceName }));
  return true;
}

async function terminateLightsailInstance(instanceName, region, accountId) {
  const ls = getLightsailClient(region, accountId);
  await ls.send(new DeleteInstanceCommand({ instanceName, forceDeleteAddOns: true }));
  return true;
}

// ========== 获取最新 Ubuntu ARM64 AMI ==========

async function getLatestUbuntuAmi(region, accountId) {
  const ec2 = getEC2Client(region, accountId);
  const res = await ec2.send(new DescribeImagesCommand({
    Filters: [
      { Name: 'name', Values: ['ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*'] },
      { Name: 'state', Values: ['available'] },
      { Name: 'architecture', Values: ['arm64'] }
    ],
    Owners: ['099720109477'] // Canonical
  }));
  const images = (res.Images || []).sort((a, b) => (b.CreationDate || '').localeCompare(a.CreationDate || ''));
  if (images.length === 0) throw new Error('未找到 Ubuntu ARM64 AMI');
  return images[0].ImageId;
}

// ========== 创建实例 ==========

async function launchEC2Instance(region, instanceType, accountId) {
  const ec2 = getEC2Client(region, accountId);
  const amiId = await getLatestUbuntuAmi(region, accountId);

  const res = await ec2.send(new RunInstancesCommand({
    ImageId: amiId,
    InstanceType: instanceType || 't4g.micro',
    MinCount: 1,
    MaxCount: 1,
    // 使用默认 VPC 和安全组，需要公网 IP
    NetworkInterfaces: [{
      DeviceIndex: 0,
      AssociatePublicIpAddress: true,
      Groups: [] // 使用默认安全组
    }]
  }));

  const instance = res.Instances?.[0];
  if (!instance) throw new Error('EC2 创建失败');
  return { instanceId: instance.InstanceId, state: instance.State?.Name };
}

async function launchLightsailInstance(region, bundleId, instanceName, accountId) {
  const ls = getLightsailClient(region, accountId);
  const az = region + 'a'; // 默认用 a 可用区
  await ls.send(new CreateInstancesCommand({
    instanceNames: [instanceName],
    availabilityZone: az,
    blueprintId: 'ubuntu_22_04',
    bundleId: bundleId || 'nano_3_0',
  }));
  return { instanceName, state: 'pending' };
}

// ========== 等待实例就绪 ==========

async function waitForInstanceRunning(instanceId, type, region, accountId, maxWaitMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      if (type === 'lightsail') {
        const instances = await listLightsailInstances(region, accountId);
        const inst = instances.find(i => i.instanceName === instanceId);
        if (inst?.state === 'running') return inst;
      } else {
        const instances = await listEC2Instances(region, accountId);
        const inst = instances.find(i => i.instanceId === instanceId);
        if (inst?.state === 'running' && (inst?.publicIp || inst?.isWavelength)) return inst;
      }
    } catch (e) {
      logger.warn({ err: e, instanceId, type, region, accountId }, '[等待实例] 查询失败');
    }
  }
  throw new Error('等待实例就绪超时');
}

// ========== 实例标签 ==========

async function tagInstance(instanceId, tags, type, region, accountId) {
  if (type === 'lightsail') {
    // Lightsail 不支持 CreateTags，跳过
    return;
  }
  const ec2 = getEC2Client(region, accountId);
  const ec2Tags = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
  await ec2.send(new CreateTagsCommand({
    Resources: [instanceId],
    Tags: ec2Tags
  }));
}

// ========== 获取所有账号的所有实例 ==========

// null = 自动发现账号中的实例区域；[] = 明确不查询；非空数组 = 手动筛选。
function getEnabledRegions() {
  try {
    const parsed = JSON.parse(db.getSetting('aws_enabled_regions') || 'null');
    if (Array.isArray(parsed)) return [...new Set(parsed.filter(r => ALL_AWS_REGIONS.includes(r)))];
  } catch (_) { /* 损坏配置回退到自动发现 */ }
  return null;
}

function scanTimeout() {
  return Object.assign(new Error('AWS 查询超时'), { name: 'TimeoutError' });
}

async function withScanTimeout(query, timeoutMs) {
  if (timeoutMs <= 0) throw scanTimeout();
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => query({ abortSignal: controller.signal })),
      new Promise((_, reject) => {
        timer = setTimeout(() => { reject(scanTimeout()); controller.abort(); }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function describeScanError(err) {
  // 仅返回错误代码和操作建议，不回传可能含代理密码/签名的原始 SDK 消息。
  const rawCode = err?.name === 'Error' ? err?.code : (err?.name || err?.code);
  const code = typeof rawCode === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(rawCode) ? rawCode : 'AwsRequestError';
  let message = '查询失败，请检查该账号的区域、凭据及网络/代理配置';
  if (/AccessDenied|Unauthorized|AuthFailure|OptInRequired/i.test(code)) message = '无权查询，请检查 IAM 权限及该区域是否已启用';
  if (/InvalidClientToken|InvalidAccessKey|Signature|ExpiredToken|Credentials/i.test(code)) message = '凭据无效或已过期，请检查该账号的 Access Key 和 Secret Key';
  if (/Timeout|Abort/i.test(code)) message = '查询超时，请减少筛选区域或检查网络/代理';
  return { code, message };
}

// 这是查询区域目录的引导端点，不代表账号或实例位于美国。
const AWS_DISCOVERY_ENDPOINT_REGION = 'us-east-1';

async function discoverAwsRegions(service, accountId, options) {
  const client = service === 'ec2' ? getEC2Client(AWS_DISCOVERY_ENDPOINT_REGION, accountId)
    : getLightsailClient(AWS_DISCOVERY_ENDPOINT_REGION, accountId);
  try {
    const response = await client.send(service === 'ec2'
      ? new DescribeRegionsCommand({ AllRegions: false })
      : new GetRegionsCommand({ includeAvailabilityZones: false }), options);
    const regions = service === 'ec2'
      ? (response.Regions || []).filter(r => r.OptInStatus !== 'not-opted-in').map(r => r.RegionName)
      : (response.regions || []).map(r => r.name);
    // 接受 AWS 返回的新区域，不依赖项目内的静态区域表是否已更新。
    return [...new Set(regions.filter(r => typeof r === 'string' && /^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(r)))].sort();
  } finally {
    client.destroy();
  }
}

async function runScanJobs(jobs, concurrency, run) {
  let index = 0;
  async function worker() {
    while (index < jobs.length) await run(jobs[index++]);
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
}

async function listAllInstances({ concurrency = 6, requestTimeoutMs = 12000, timeoutMs = 45000 } = {}) {
  const accounts = db.getAwsAccounts(true);
  const nodeMap = new Map();
  for (const n of db.getAllNodes()) {
    if (n.aws_instance_id && n.aws_account_id) nodeMap.set(`${n.aws_account_id}:${n.aws_region}:${n.aws_instance_id}`, n);
  }
  const enabledRegions = getEnabledRegions();
  const results = accounts.map(account => ({
    accountId: account.id, accountName: account.name, instances: [], errors: [],
    queriedRegions: [], discoveredRegions: [], autoDiscover: enabledRegions === null, status: 'ok'
  }));
  const jobs = [];
  const deadline = Date.now() + timeoutMs;
  if (enabledRegions === null) {
    // 分别发现 EC2 与 Lightsail 区域；某个服务无权限不会阻止另一个服务。
    const discoveryJobs = results.flatMap(result => ['ec2', 'lightsail'].map(service => ({ result, service })));
    await runScanJobs(discoveryJobs, concurrency, async ({ result, service }) => {
      let regions;
      try {
        regions = await withScanTimeout(options => discoverAwsRegions(service, result.accountId, options),
          Math.min(requestTimeoutMs, deadline - Date.now()));
      } catch (err) {
        // 某些 IAM 策略允许查实例但不允许列区域；保留已知区域回退，并明确提示不完整。
        const detail = describeScanError(err);
        result.errors.push({ region: '区域发现', service, operation: service === 'ec2' ? 'DescribeRegions' : 'GetRegions',
          ...detail, message: detail.message + '；区域列表读取失败，已尝试已知区域' });
        regions = service === 'ec2' ? ALL_AWS_REGIONS : [...LIGHTSAIL_REGIONS];
      }
      for (const region of regions) jobs.push({ result, region, service });
      result.queriedRegions.push(...regions);
    });
  } else {
    for (const result of results) {
      result.queriedRegions = [...enabledRegions];
      for (const region of enabledRegions) {
        jobs.push({ result, region, service: 'ec2' });
        if (LIGHTSAIL_REGIONS.has(region)) jobs.push({ result, region, service: 'lightsail' });
      }
    }
  }
  for (const result of results) result.queriedRegions = [...new Set(result.queriedRegions)].sort();
  const successes = new Map();
  let nextJob = 0;
  async function worker() {
    while (nextJob < jobs.length) {
      const { result, region, service } = jobs[nextJob++];
      try {
        const list = await withScanTimeout(options => service === 'ec2'
          ? listEC2Instances(region, result.accountId, options)
          : listLightsailInstances(region, result.accountId, options),
        Math.min(requestTimeoutMs, deadline - Date.now()));
        successes.set(result.accountId, (successes.get(result.accountId) || 0) + 1);
        for (const inst of list) {
          if (inst.state === 'terminated') continue;
          const instanceId = service === 'ec2' ? inst.instanceId : inst.instanceName;
          const instanceRegion = inst.region || region;
          const node = nodeMap.get(`${result.accountId}:${instanceRegion}:${instanceId}`);
          result.instances.push({
            ...inst, instanceId, name: inst.name || inst.instanceName || '', region: instanceRegion,
            instanceType: service, ...(service === 'ec2' ? { ec2Type: inst.type } : {}),
            accountId: result.accountId, accountName: result.accountName,
            boundNode: node ? { id: node.id, name: node.name, host: node.host, remark: node.remark, is_active: node.is_active } : null
          });
        }
      } catch (err) {
        const error = { region, service, ...describeScanError(err) };
        result.errors.push(error);
        logger.warn({ accountId: result.accountId, ...error }, '[AWS] 实例查询失败');
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  for (const result of results) {
    result.discoveredRegions = [...new Set(result.instances.map(i => i.region))].sort();
    result.status = result.errors.length ? (successes.get(result.accountId) ? 'partial' : 'error')
      : enabledRegions?.length === 0 ? 'skipped' : 'ok';
    result.instances.sort((a, b) => `${a.region}:${a.instanceType}:${a.instanceId}`.localeCompare(`${b.region}:${b.instanceType}:${b.instanceId}`));
    result.errors.sort((a, b) => `${a.region}:${a.service}`.localeCompare(`${b.region}:${b.service}`));
  }
  return results;
}

module.exports = {
  getAwsConfig, setAwsConfig,
  listEC2Instances, swapEC2Ip, terminateEC2Instance, startEC2Instance, stopEC2Instance,
  listLightsailInstances, swapLightsailIp,
  startLightsailInstance, stopLightsailInstance, terminateLightsailInstance,
  swapNodeIp,
  getLatestUbuntuAmi, launchEC2Instance, launchLightsailInstance,
  waitForInstanceRunning, tagInstance, listAllInstances,
  ALL_AWS_REGIONS, AWS_REGION_META, getEnabledRegions,
};
