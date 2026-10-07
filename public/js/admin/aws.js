/* aws.js — AWS 账号管理、实例仪表盘、绑定/解绑、新建实例 */

window._awsAccounts = [];

function readAwsQueryServices(id) {
  const selected = document.getElementById(id).value;
  return selected === 'ec2' || selected === 'lightsail' ? [selected] : ['ec2', 'lightsail'];
}

function renderAwsQueryErrors(account) {
  const errors = account.errors || [];
  if (!errors.length) return '';
  const serviceNames = [...new Set(errors.map(e => e.service === 'lightsail' ? 'Lightsail' : 'EC2'))].join(' / ');
  const summary = account.status === 'error' ? serviceNames + ' 查询失败，无法确认是否有实例'
    : '已显示 ' + account.instances.length + ' 个实例；' + serviceNames + ' 查询未完成';
  const groups = new Map();
  for (const error of errors) {
    const key = JSON.stringify([error.service, error.operation, error.code, error.message]);
    if (!groups.has(key)) groups.set(key, { ...error, regions: new Set() });
    groups.get(key).regions.add(error.region);
  }
  const color = account.status === 'error' ? 'text-red-400' : 'text-amber-300';
  const rows = [...groups.values()].map(e => '<li class="mb-2">' +
    escapeHtml(e.service === 'lightsail' ? 'Lightsail' : 'EC2') + ' · ' +
    escapeHtml(e.operation ? e.operation + ' / ' + e.code : e.code) + '：' + escapeHtml(e.message) +
    '<div class="text-gray-400">区域：' + escapeHtml([...e.regions].join(', ')) + '</div></li>').join('');
  return '<details class="text-xs text-left mb-3 px-3 py-2 rounded-xl bg-black/20 ' + color + '">' +
    '<summary class="cursor-pointer">' + escapeHtml(summary) + ' · 查看详情（' + errors.length + ' 项）</summary>' +
    '<ul class="mt-2">' + rows + '</ul>' +
    '<button type="button" data-action="edit-aws-services" data-account-id="' + (parseInt(account.accountId) || 0) +
    '" class="text-gray-300 px-2 py-1 rounded-lg bg-white/5">编辑此账号的查询服务</button></details>';
}

function invalidateAwsInstancesCache() {
  _awsInstancesRevision += 1;
  try { localStorage.removeItem(AWS_CACHE_KEY); } catch (_) {}
  document.getElementById('aws-instances-loading').classList.add('hidden');
  const container = document.getElementById('aws-instances-container');
  container.textContent = '配置已更新，点击「刷新实例」重新查询';
  container.classList.remove('hidden');
}

async function loadAwsConfig() {
  const res = await fetch('/admin/api/aws/config');
  const cfg = await res.json();
  window._awsAccounts = cfg.accounts || [];
  const el = document.getElementById('aws-status');
  const list = document.getElementById('aws-accounts');
  const bindSel = document.getElementById('bind-account-id');

  if (cfg.configured) {
    el.textContent = '✅ ' + cfg.count + ' 个账号';
    el.className = 'text-xs px-2 py-0.5 rounded-full bg-white/10 text-gray-300';
  } else {
    el.textContent = '未配置';
    el.className = 'text-xs px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-400';
  }

  list.innerHTML = (cfg.accounts || []).map(a =>
    '<div class="flex items-center justify-between rounded-xl bg-black/20 border border-white/5 px-3 py-2.5">' +
    '<div class="min-w-0"><div class="text-xs text-white font-medium truncate">#' + escapeHtml(a.id) + ' ' + escapeHtml(a.name) + '</div>' +
    '<div class="text-[11px] text-gray-500 mt-0.5 truncate">' + escapeHtml(a.accessKeyMasked) + ' · ' + escapeHtml((a.queryServices || ['ec2', 'lightsail']).map(service => service === 'ec2' ? 'EC2' : 'Lightsail').join(' / ')) + ' · 自动发现实例区域' + (a.socks5_host ? ' · SOCKS ' + escapeHtml(a.socks5_host) + ':' + escapeHtml(a.socks5_port) : '') + '</div></div>' +
    '<div class="flex items-center gap-2">' +
    '<button type="button" data-action="edit-aws-account" data-aws-id="' + parseInt(a.id) + '" class="text-gray-300 hover:text-white text-xs px-2 py-1 rounded-lg bg-white/5 border border-white/10">编辑</button>' +
    '<button type="button" data-action="delete-aws-account" data-aws-id="' + parseInt(a.id) + '" class="text-red-400 hover:text-red-300 text-xs px-2 py-1 rounded-lg bg-red-500/10 border border-red-500/20">删除</button>' +
    '</div></div>'
  ).join('') || '<p class="text-gray-500 text-xs">暂无 AWS 账号</p>';

  if (!list.dataset.boundActions) {
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action][data-aws-id]');
      if (!btn) return;
      const id = parseInt(btn.dataset.awsId, 10);
      if (!Number.isFinite(id)) return;
      if (btn.dataset.action === 'edit-aws-account') editAwsAccount(id);
      if (btn.dataset.action === 'delete-aws-account') deleteAwsAccount(id);
    });
    list.dataset.boundActions = '1';
  }

  bindSel.innerHTML = (cfg.accounts || []).map(a => '<option value="' + escapeHtml(a.id) + '">#' + escapeHtml(a.id) + ' ' + escapeHtml(a.name) + '</option>').join('');
}

async function saveAwsConfig() {
  const name = document.getElementById('aws-name').value.trim();
  const queryServices = readAwsQueryServices('aws-query-services');
  const ak = document.getElementById('aws-ak').value.trim();
  const sk = document.getElementById('aws-sk').value.trim();
  const socks5Url = document.getElementById('aws-socks-url').value.trim();
  if (!name) { toast('请填写账号名', 2500, 'error'); return; }
  if (!ak) { toast('请填写 Access Key', 2500, 'error'); return; }
  if (!sk) { toast('请填写 Secret Key', 2500, 'error'); return; }

  const res = await fetch('/admin/api/aws/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window._csrf || '' },
    body: JSON.stringify({ name, accessKey: ak, secretKey: sk, socks5Url, queryServices })
  });
  if (res.ok) {
    invalidateAwsInstancesCache();
    showToast('✅ AWS 账号已新增，正在查询实例');
    ['aws-name', 'aws-ak', 'aws-sk', 'aws-socks-url'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('aws-socks-test-result').textContent = '';
    await loadAwsConfig();
    await loadAllInstances(true);
  } else {
    const d = await res.json().catch(() => ({}));
    showToast('❌ ' + (d.error || '保存失败'));
  }
}

async function testSocksProxyInput(inputId, resultId) {
  const socks5Url = document.getElementById(inputId).value.trim();
  const resultEl = document.getElementById(resultId);
  if (!socks5Url) { showToast('请先填写 SOCKS5 URL'); return; }
  resultEl.textContent = '验证中...';
  const res = await fetch('/admin/api/aws/socks-test', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window._csrf || '' },
    body: JSON.stringify({ socks5Url })
  });
  const d = await res.json().catch(() => ({}));
  if (res.ok && d.ok) {
    resultEl.textContent = '✅ 代理可用，出口 IP: ' + d.ip;
    resultEl.className = 'text-[11px] text-emerald-400 mt-1';
  } else {
    resultEl.textContent = '❌ 验证失败: ' + (d.error || '未知错误');
    resultEl.className = 'text-[11px] text-red-400 mt-1';
  }
}

async function testSocksProxy() {
  return testSocksProxyInput('aws-socks-url', 'aws-socks-test-result');
}

async function deleteAwsAccount(id) {
  if (!await _confirm('确定删除该 AWS 账号？')) return;
  const res = await fetch('/admin/api/aws/config/' + id, { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window._csrf || '' } });
  if (res.ok) { invalidateAwsInstancesCache(); showToast('✅ 已删除账号'); loadAwsConfig(); }
  else showToast('❌ 删除失败');
}

function editAwsAccount(id) {
  const a = (window._awsAccounts || []).find(x => x.id === id);
  if (!a) { showToast('账号不存在'); return; }
  document.getElementById('edit-aws-id').value = id;
  document.getElementById('edit-aws-name').value = a.name || '';
  const services = a.queryServices || ['ec2', 'lightsail'];
  document.getElementById('edit-aws-query-services').value = services.length === 1 ? services[0] : 'both';
  document.getElementById('edit-aws-ak').value = a.accessKeyMasked || '';
  document.getElementById('edit-aws-socks').value = a.socks5_host ? 'socks5://' + a.socks5_host + ':' + (a.socks5_port || 1080) : '';
  document.getElementById('edit-aws-socks').dataset.originalValue = document.getElementById('edit-aws-socks').value;
  document.getElementById('edit-aws-socks-test').textContent = '';
  document.getElementById('aws-edit-modal').classList.remove('hidden');
}

function closeAwsEditModal() {
  document.getElementById('aws-edit-modal').classList.add('hidden');
}

async function saveAwsEdit() {
  const id = parseInt(document.getElementById('edit-aws-id').value);
  const name = document.getElementById('edit-aws-name').value.trim();
  const queryServices = readAwsQueryServices('edit-aws-query-services');
  const socksInput = document.getElementById('edit-aws-socks');
  // 显示值不含已保存的代理密码。只在用户改动时提交，避免编辑区域时清除代理认证。
  const socks5Url = socksInput.value.trim() === socksInput.dataset.originalValue ? undefined : socksInput.value.trim();
  if (!id) { showToast('参数错误'); return; }
  if (!name) { showToast('账号名不能为空'); return; }
  const res = await fetch('/admin/api/aws/config/' + id, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window._csrf || '' },
    body: JSON.stringify({ name, socks5Url, queryServices })
  });
  const d = await res.json().catch(() => ({}));
  if (res.ok) {
    invalidateAwsInstancesCache(); showToast('✅ 账号已更新'); closeAwsEditModal();
    await loadAwsConfig(); await loadAllInstances(true);
  }
  else showToast('❌ ' + (d.error || '更新失败'));
}

function showBindAws(nodeId) {
  document.getElementById('bind-node-id').value = nodeId;
  if (!window._awsAccounts || window._awsAccounts.length === 0) { showToast('请先新增 AWS 账号'); return; }
  document.getElementById('aws-bind-modal').classList.remove('hidden');
}

async function confirmBindAws() {
  const nodeId = document.getElementById('bind-node-id').value;
  const data = {
    aws_account_id: parseInt(document.getElementById('bind-account-id').value),
    aws_instance_id: document.getElementById('bind-instance-id').value.trim(),
    aws_type: document.getElementById('bind-type').value,
    aws_region: document.getElementById('bind-region').value || null
  };
  if (!data.aws_account_id) { showToast('请选择 AWS 账号'); return; }
  if (!data.aws_instance_id) { showToast('请填写实例 ID'); return; }
  const res = await fetch('/admin/api/nodes/' + nodeId + '/aws-bind', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window._csrf || '' }, body: JSON.stringify(data) });
  if (res.ok) { showToast('✅ 已绑定'); document.getElementById('aws-bind-modal').classList.add('hidden'); location.hash = 'aws'; location.reload(); }
  else showToast('❌ 绑定失败');
}

async function unbindAws(nodeId) {
  if (!await _confirm('确定解绑？')) return;
  const res = await fetch('/admin/api/nodes/' + nodeId + '/aws-bind', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window._csrf || '' }, body: JSON.stringify({ aws_instance_id: null, aws_type: null, aws_region: null, aws_account_id: null }) });
  if (res.ok) { showToast('✅ 已解绑'); location.hash = 'aws'; location.reload(); }
}

async function swapNodeIp(nodeId, nodeName, btn) {
  if (!await _confirm('确定给 ' + nodeName + ' 换 IP？将释放旧 IP 并分配新 IP')) return;
  const done = btnLoading(btn, '🔄 换IP中...');
  try {
    const res = await fetch('/admin/api/nodes/' + nodeId + '/swap-ip', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window._csrf || '' } });
    const data = await res.json();
    if (data.success) { toast('✅ 换 IP 成功: ' + data.newIp); setTimeout(() => { location.hash = 'aws'; location.reload(); }, 1500); }
    else toast('❌ ' + (data.error || '换 IP 失败'), 3000, 'error');
  } catch (e) { toast('❌ 网络错误', 3000, 'error'); }
  done();
}

const AWS_CACHE_KEY = 'aws_instances_cache_v4';
let _awsInstancesRevision = 0;
const AWS_CACHE_TTL = 30 * 60 * 1000; // 30 分钟

async function loadAllInstances(force) {
  const loading = document.getElementById('aws-instances-loading');
  const container = document.getElementById('aws-instances-container');
  const revision = ++_awsInstancesRevision;

  // 非强制刷新时尝试读缓存
  if (!force) {
    try {
      const cached = JSON.parse(localStorage.getItem(AWS_CACHE_KEY) || 'null');
      if (cached && Date.now() - cached.ts < AWS_CACHE_TTL) {
        loading.classList.add('hidden');
        renderInstances(cached.data, container);
        return;
      }
    } catch (e) { console.warn('AWS cache read failed:', e); }
  }

  loading.textContent = '⏳ 正在发现并查询实例，首次查询可能需要几十秒...';
  loading.classList.remove('hidden');
  container.classList.add('hidden');
  try {
    const res = await fetch('/admin/api/aws/all-instances?force=1');
    const accounts = await res.json();
    if (revision !== _awsInstancesRevision) return;
    if (!res.ok) throw new Error(accounts.error || '加载失败');

    try {
      if (accounts.every(a => !a.errors?.length)) {
        localStorage.setItem(AWS_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: accounts }));
      } else localStorage.removeItem(AWS_CACHE_KEY);
    } catch (_) { /* 禁用浏览器存储时仍显示查询结果 */ }
    renderInstances(accounts, container);
    loading.classList.add('hidden');
    container.classList.remove('hidden');
  } catch (e) {
    if (revision !== _awsInstancesRevision) return;
    try { localStorage.removeItem(AWS_CACHE_KEY); } catch (_) {}
    loading.textContent = '❌ ' + e.message;
  }
}

function renderInstances(accounts, container) {

    const regionNames = {
      'us-east-1': '🇺🇸 弗吉尼亚', 'us-east-2': '🇺🇸 俄亥俄', 'us-west-1': '🇺🇸 加州', 'us-west-2': '🇺🇸 俄勒冈',
      'ap-northeast-1': '🇯🇵 东京', 'ap-northeast-2': '🇰🇷 首尔', 'ap-northeast-3': '🇯🇵 大阪',
      'ap-southeast-1': '🇸🇬 新加坡', 'ap-southeast-2': '🇦🇺 悉尼', 'ap-south-1': '🇮🇳 孟买', 'ap-east-1': '🇭🇰 香港',
      'eu-west-1': '🇮🇪 爱尔兰', 'eu-west-2': '🇬🇧 伦敦', 'eu-central-1': '🇩🇪 法兰克福',
      'ca-central-1': '🇨🇦 多伦多', 'sa-east-1': '🇧🇷 圣保罗'
    };

    let html = '';
    for (const acc of accounts) {
      html += '<div class="mb-5">' +
        '<div class="text-sm text-gray-400 mb-3 px-1">📦 ' + escapeHtml(acc.accountName) + ' <span class="text-gray-600">#' + escapeHtml(acc.accountId) + '</span></div>';

      if (acc.discoveredRegions?.length) {
        html += '<p class="text-xs text-gray-400 mb-3">发现实例区域：' + escapeHtml(acc.discoveredRegions.join(', ')) + '</p>';
      }
      const errors = acc.errors || [];
      if (errors.length) {
        html += renderAwsQueryErrors(acc);
      } else if (acc.instances.length === 0) {
        html += '<p class="text-gray-500 text-xs mb-3">' + (acc.status === 'skipped'
          ? '未选择查询区域，请调整区域筛选后刷新'
          : acc.autoDiscover && !acc.queriedRegions?.length ? 'AWS 未返回可查询区域'
          : (acc.autoDiscover ? '已查询区域未发现实例：' : '所选区域暂无实例：') + escapeHtml((acc.queriedRegions || []).join(', '))) + '</p>';
      }

      const byRegion = {};
      for (const inst of acc.instances) {
        const r = inst.region || 'unknown';
        if (!byRegion[r]) byRegion[r] = [];
        byRegion[r].push(inst);
      }

      for (const [region, instances] of Object.entries(byRegion)) {
        const regionLabel = regionNames[region] || '🌐 ' + region;
        html += '<div class="mb-4">' +
          '<div class="text-sm text-gray-500 mb-2 px-1">' + regionLabel + '</div>' +
          '<div class="grid grid-cols-2 gap-3">';

        for (const inst of instances) {
          const isBlocked = inst.boundNode && (inst.boundNode.remark?.includes('被墙') || inst.boundNode.remark?.includes('离线') || !inst.boundNode.is_active);
          const safeInstId = encodeURIComponent(inst.instanceId || '');
          const safeInstType = encodeURIComponent(inst.instanceType || '');
          const safeRegion = encodeURIComponent(inst.region || '');
          const safeAccId = parseInt(inst.accountId) || 0;

          const stateColor = inst.state === 'running' ? 'border-emerald-500/20' : inst.state === 'stopped' ? 'border-gray-700' : 'border-yellow-500/20';
          const cardBg = isBlocked ? 'bg-red-500/5 border-red-500/20' : 'bg-white/[0.03] ' + stateColor;
          const dotColor = inst.state === 'running' ? 'bg-emerald-400' : inst.state === 'stopped' ? 'bg-gray-600' : 'bg-yellow-400';
          const typeBadge = inst.instanceType === 'lightsail'
            ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400">LS</span>'
            : (inst.isWavelength
              ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-400">EC2</span><span class="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-400">WL</span>'
              : '<span class="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-400">EC2</span>');

          html += '<div class="' + cardBg + ' border rounded-2xl p-4 flex flex-col gap-3">' +
            // 第一行：状态点 + 名称 + 类型
            '<div class="flex items-center gap-2">' +
            '<span class="w-2.5 h-2.5 rounded-full ' + dotColor + ' flex-shrink-0"></span>' +
            '<span class="text-base text-white font-semibold truncate flex-1">' + escapeHtml(inst.name || inst.instanceId) + '</span>' +
            typeBadge +
            '</div>' +
            // 第二行：IP
            '<div class="text-sm font-mono ' + (inst.publicIp ? 'text-blue-300/90' : 'text-gray-500 italic') + '">' +
            (inst.publicIp || '无公网 IP') + '</div>' +
            // 第三行：绑定节点
            (inst.boundNode
              ? '<div class="text-sm truncate ' + (isBlocked ? 'text-red-400' : 'text-emerald-300/90') + '">' +
                (isBlocked ? '⚠️ ' : '🔗 ') + escapeHtml(inst.boundNode.name) + '</div>'
              : '<div class="text-sm text-gray-600">未绑定节点</div>') +
            // 换 IP 按钮（仅 running 实例）
            (inst.state === 'running'
              ? '<button type="button" data-action="aws-swap-ip" data-instance-id="' + safeInstId + '" data-instance-type="' + safeInstType + '" data-region="' + safeRegion + '" data-account-id="' + safeAccId + '" ' +
                'class="text-sm w-full py-2 rounded-xl text-center transition-colors ' +
                (isBlocked
                  ? 'bg-red-500/20 text-red-200 hover:bg-red-500/30'
                  : 'bg-white/5 text-gray-300 hover:bg-amber-500/20 hover:text-amber-200') + '">🔄 换 IP</button>'
              : '<div class="text-sm text-center text-gray-600 py-2">' + escapeHtml(inst.state) + '</div>') +
            '</div>';
        }
        html += '</div></div>';
      }
      html += '</div>';
    }
    if (!html) html = '<p class="text-gray-500 text-sm text-center py-4">暂无实例</p>';
    container.innerHTML = html;
    if (!container.dataset.boundSwapAction) {
      container.addEventListener('click', (e) => {
        const edit = e.target.closest('button[data-action="edit-aws-services"]');
        if (edit) { editAwsAccount(parseInt(edit.dataset.accountId, 10)); return; }
        const btn = e.target.closest('button[data-action="aws-swap-ip"]');
        if (!btn) return;
        awsSwapIp(
          decodeURIComponent(btn.dataset.instanceId || ''),
          decodeURIComponent(btn.dataset.instanceType || ''),
          decodeURIComponent(btn.dataset.region || ''),
          parseInt(btn.dataset.accountId || '0', 10) || 0
        );
      });
      container.dataset.boundSwapAction = '1';
    }
    container.classList.remove('hidden');
}

async function awsSwapIp(instanceId, type, region, accountId) {
  if (!await _confirm('确定给 ' + instanceId + ' 换 IP？')) return;
  showToast('⏳ 换 IP 中...');
  try {
    const res = await fetch('/admin/api/aws/swap-ip', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window._csrf || '' },
      body: JSON.stringify({ instanceId, type, region, accountId })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast('✅ 换 IP 成功' + (data.newIp ? ' 新IP: ' + data.newIp : ''));
      setTimeout(() => loadAllInstances(true), 2000);
    } else {
      showToast('❌ ' + (data.error || '换 IP 失败'));
    }
  } catch (e) { showToast('❌ 网络错误'); }
}

// ─── AWS 区域筛选 ───
let _awsRegionsData = null;
async function loadAwsRegions() {
  const container = document.getElementById('aws-regions-list');
  if (!container) return;
  try {
    const res = await fetch('/admin/api/aws/regions', { credentials: 'same-origin' });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || '区域加载失败');
    _awsRegionsData = d;
    renderAwsRegions(d);
  } catch (e) {
    container.innerHTML = '<span class="text-red-400">加载失败</span>';
  }
}
function renderAwsRegions(d) {
  const container = document.getElementById('aws-regions-list');
  const enabledSet = new Set(d.enabled);
  document.getElementById('aws-regions-auto').checked = d.autoDiscover;
  // 按分组组织
  const groups = {};
  for (const region of d.all) {
    const meta = d.meta[region] || { group: '其他', name: region };
    if (!groups[meta.group]) groups[meta.group] = [];
    groups[meta.group].push({ region, name: meta.name });
  }
  const groupOrder = ['美洲', '欧洲', '亚太', '中东与非洲', '其他'];
  const sortedGroups = Object.keys(groups).sort((a, b) => groupOrder.indexOf(a) - groupOrder.indexOf(b));
  let html = '';
  for (const g of sortedGroups) {
    html += `<div class="mb-4 last:mb-0">
      <h4 class="text-gray-400 text-xs font-medium mb-2 uppercase tracking-wider">${g}</h4>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">`;
    for (const item of groups[g]) {
      const checked = enabledSet.has(item.region) ? 'checked' : '';
      const meta = d.meta[item.region] || {};
      const lsBadge = meta.lightsail
        ? '<span class="text-[9px] px-1 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/20">EC2+LS</span>'
        : '<span class="text-[9px] px-1 py-0.5 rounded bg-gray-500/15 text-gray-500 border border-gray-500/20">仅 EC2</span>';
      html += `<label class="flex items-center justify-between p-2.5 rounded-xl bg-black/20 cursor-pointer hover:bg-white/5 transition">
        <div class="flex flex-col text-left min-w-0 flex-1">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="text-white text-xs truncate">${item.name}</span>
            ${lsBadge}
          </div>
          <span class="text-gray-600 text-[10px] font-mono">${item.region}</span>
        </div>
        <div class="relative shrink-0 ml-2">
          <input type="checkbox" data-region="${item.region}" class="js-aws-region-toggle sr-only peer" ${checked}>
          <div class="w-9 h-5 bg-gray-600 rounded-full peer-checked:bg-rose-500 transition-colors"></div>
          <div class="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-4"></div>
        </div>
      </label>`;
    }
    html += '</div></div>';
  }
  container.innerHTML = html;
  container.classList.remove('text-center', 'py-6');
  updateAwsRegionsCount();
}
function updateAwsRegionsCount() {
  const all = document.querySelectorAll('.js-aws-region-toggle');
  const checked = document.querySelectorAll('.js-aws-region-toggle:checked');
  const btnSave = document.getElementById('btn-aws-regions-save');
  const autoDiscover = document.getElementById('aws-regions-auto').checked;
  all.forEach(c => { c.disabled = autoDiscover; });
  if (btnSave) btnSave.textContent = autoDiscover ? '保存（自动发现）' : `保存 (${checked.length}/${all.length})`;
}
document.addEventListener('change', (e) => {
  if (e.target?.classList?.contains('js-aws-region-toggle') || e.target?.id === 'aws-regions-auto') updateAwsRegionsCount();
});
document.getElementById('btn-aws-regions-all')?.addEventListener('click', () => {
  document.getElementById('aws-regions-auto').checked = false;
  document.querySelectorAll('.js-aws-region-toggle').forEach(c => { c.checked = true; });
  updateAwsRegionsCount();
});
document.getElementById('btn-aws-regions-none')?.addEventListener('click', () => {
  document.getElementById('aws-regions-auto').checked = false;
  document.querySelectorAll('.js-aws-region-toggle').forEach(c => { c.checked = false; });
  updateAwsRegionsCount();
});
document.getElementById('btn-aws-regions-save')?.addEventListener('click', async () => {
  const regions = document.getElementById('aws-regions-auto').checked ? null
    : Array.from(document.querySelectorAll('.js-aws-region-toggle:checked')).map(c => c.dataset.region);
  const btn = document.getElementById('btn-aws-regions-save');
  btn.disabled = true;
  try {
    const res = await fetch('/admin/api/aws/regions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window._csrf || '' },
      body: JSON.stringify({ regions }),
    });
    const d = await res.json();
    if (d.ok) {
      invalidateAwsInstancesCache();
      showToast(d.autoDiscover ? '✅ 已改为自动发现实例区域' : `✅ 已保存 ${d.count} 个启用区域`);
    }
    else showToast('❌ ' + (d.error || '保存失败'));
  } catch { showToast('❌ 网络错误'); }
  btn.disabled = false;
  updateAwsRegionsCount();
});
// 切换到 AWS Tab 时加载（也支持页面初次直接进入 AWS Tab）
// 监听点击和键盘切换两种入口
document.querySelectorAll('.tab-btn[data-tab="aws"]').forEach(b => b.addEventListener('click', () => {
  if (!_awsRegionsData) loadAwsRegions();
}));
// hash 直接定位到 #aws，或包装 switchTab 钩子
if (typeof window.switchTab === 'function') {
  const _origSwitch = window.switchTab;
  window.switchTab = function (name) {
    _origSwitch(name);
    if (name === 'aws' && !_awsRegionsData) loadAwsRegions();
  };
}
// 进入页面时直接加载（即便不在 aws tab 也无副作用，只是预先填好数据）
loadAwsRegions();
// core.js 先加载，直接进入 #aws 时需要在本模块就绪后读取账号。
if (location.hash === '#aws') loadAwsConfig();
