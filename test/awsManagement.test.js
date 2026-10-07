const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');
const Sqlite = require('better-sqlite3');

process.env.SESSION_SECRET ||= 'aws-regression-test-only';
const logger = { info() {}, warn() {}, debug() {}, error() {} };

function loadModule(relative, mocks = {}, extra = {}) {
  const filename = path.resolve(__dirname, '..', relative);
  const realRequire = createRequire(filename);
  const context = { module: { exports: {} }, process, Buffer, URL, AbortController,
    setTimeout, clearTimeout, __dirname: path.dirname(filename),
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : realRequire(name), ...extra };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context.module.exports;
}

function database(t) {
  const sqlite = new Sqlite(':memory:');
  const db = loadModule('src/services/database.js', {
    'better-sqlite3': function () { return sqlite; }, fs: { mkdirSync() {} }
  });
  db.getDb();
  sqlite.prepare('INSERT INTO users (id, username, sub_token, is_admin) VALUES (1, ?, ?, 1)').run('test-admin', 'fake-sub-token');
  t.after(() => sqlite.close());
  return { db, sqlite };
}

function addAccount(db, region = 'ap-southeast-1') {
  return Number(db.addAwsAccount({ name: 'test account', access_key: 'fake-access-key',
    secret_key: 'fake-secret-key', default_region: region,
    socks5_host: 'proxy.test', socks5_user: 'proxy-user', socks5_pass: 'fake-proxy-password'
  }).lastInsertRowid);
}

const migrate = sqlite => require('../src/services/migrations').runMigrations(sqlite);

test('fresh application initialization supports encrypted AWS account CRUD', t => {
  const { db, sqlite } = database(t);
  const id = addAccount(db);
  const saved = db.getAwsAccountById(id);
  assert.equal(saved.default_region, 'ap-southeast-1');
  assert.equal(saved.secret_key, 'fake-secret-key');
  const raw = sqlite.prepare('SELECT * FROM aws_accounts WHERE id = ?').get(id);
  assert.notEqual(raw.secret_key, saved.secret_key);
  db.updateAwsAccount(id, { default_region: 'ap-northeast-1' });
  assert.equal(db.getAwsAccountById(id).default_region, 'ap-northeast-1');
  db.deleteAwsAccount(id);
  assert.equal(db.getAwsAccounts().length, 0);
  const fallback = db.addAwsAccount({ name: 'default', access_key: 'fake', secret_key: 'fake' });
  assert.equal(db.getAwsAccountById(fallback.lastInsertRowid).default_region, 'us-east-1');
});

test('upgrade creates the missing AWS table and repeated migrations preserve account ciphertext', t => {
  const { db, sqlite } = database(t);
  sqlite.exec('DROP TABLE aws_accounts');
  migrate(sqlite);
  addAccount(db);
  const before = sqlite.prepare('SELECT * FROM aws_accounts').all();
  migrate(sqlite);
  migrate(sqlite);
  assert.deepEqual(sqlite.prepare('SELECT * FROM aws_accounts').all(), before);
});

test('migration accepts the manually created production schema without changing data', t => {
  const { db, sqlite } = database(t);
  addAccount(db);
  const legacy = sqlite.prepare('SELECT * FROM aws_accounts').get();
  delete legacy.query_services;
  sqlite.exec(`DROP TABLE aws_accounts;
    CREATE TABLE aws_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      access_key TEXT NOT NULL, secret_key TEXT NOT NULL,
      default_region TEXT DEFAULT 'us-east-1', socks5_host TEXT,
      socks5_port INTEGER DEFAULT 1080, socks5_user TEXT, socks5_pass TEXT,
      enabled INTEGER DEFAULT 1, updated_at TEXT DEFAULT (datetime('now'))
    )`);
  const keys = Object.keys(legacy);
  sqlite.prepare(`INSERT INTO aws_accounts (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(legacy));
  const before = sqlite.prepare('SELECT * FROM aws_accounts').all();
  migrate(sqlite);
  assert.deepEqual(sqlite.prepare(`SELECT ${keys.join(',')} FROM aws_accounts`).all(), before);
  assert.deepEqual(JSON.parse(db.getAwsAccounts()[0].query_services), ['ec2', 'lightsail']);
  assert.equal(db.getAwsAccounts()[0].socks5_pass, 'fake-proxy-password');
});

function serviceHarness({ db, saved = null, accounts, send, discover } = {}) {
  const rows = accounts || [{ id: 1, name: 'Singapore', enabled: 1, default_region: 'ap-southeast-1',
    access_key: 'fake', secret_key: 'fake' }];
  const fakeDb = db || { getAwsAccounts: () => rows, getAwsAccountById: id => rows.find(a => a.id === id),
    getAllNodes: () => [], getSetting: () => saved };
  const calls = [];
  let active = 0, peak = 0, destroyed = 0;
  const client = service => class {
    constructor(config) {
      this.region = config.region;
      this.accountId = fakeDb.getAwsAccounts().find(a => a.access_key === config.credentials.accessKeyId)?.id;
    }
    async send(command, options) {
      const discovery = ['DescribeRegionsCommand', 'GetRegionsCommand'].includes(command.constructor.name);
      calls.push({ service, region: this.region, command, options, discovery, accountId: this.accountId });
      active++; peak = Math.max(peak, active);
      try {
        if (discovery) return discover ? await discover({ service, command, options, accountId: this.accountId })
          : service === 'ec2' ? { Regions: [{ RegionName: 'ap-southeast-1', OptInStatus: 'opt-in-not-required' }] }
            : { regions: [{ name: 'ap-southeast-1' }] };
        return send ? await send({ service, region: this.region, command, options })
          : service === 'ec2' ? { Reservations: [] } : { instances: [] };
      } finally { active--; }
    }
    destroy() { destroyed++; }
  };
  const aws = loadModule('src/services/aws.js', {
    './database': fakeDb, './logger': logger,
    '@aws-sdk/client-ec2': { ...require('@aws-sdk/client-ec2'), EC2Client: client('ec2') },
    '@aws-sdk/client-lightsail': { ...require('@aws-sdk/client-lightsail'), LightsailClient: client('lightsail') }
  });
  return { aws, calls, peak: () => peak, destroyed: () => destroyed };
}

for (const [label, saved, expected] of [
  ['unset', null, ['ap-southeast-1']], ['invalid JSON', '{broken', ['ap-southeast-1']],
  ['explicit empty', '[]', []], ['explicit selection', '["us-west-2"]', ['us-west-2']],
  ['deduplicated selection', '["us-west-2","us-west-2"]', ['us-west-2']]
]) {
  test(`discovery respects ${label} region configuration`, async () => {
    const h = serviceHarness({ saved });
    const [result] = await h.aws.listAllInstances();
    const instanceCalls = h.calls.filter(c => !c.discovery);
    assert.deepEqual([...new Set(instanceCalls.map(c => c.region))], expected);
    assert.equal(instanceCalls.length, expected.length * 2);
    assert.equal(result.status, expected.length ? 'ok' : 'skipped');
    assert.equal(h.destroyed(), h.calls.length);
  });
}

test('automatic discovery uses each account response and ignores stale default regions', async () => {
  const h = serviceHarness({ accounts: [
    { id: 1, enabled: 1, default_region: 'us-east-1', access_key: 'fake-1' },
    { id: 2, enabled: 1, default_region: 'ap-southeast-1', access_key: 'fake-2' }
  ], discover: async ({ service, accountId }) => {
    const region = accountId === 1 ? 'ap-southeast-1' : 'eu-central-1';
    return service === 'ec2' ? { Regions: [{ RegionName: region }] } : { regions: [{ name: region }] };
  } });
  const results = await h.aws.listAllInstances();
  assert.deepEqual(results.map(r => Array.from(r.queriedRegions)).flat(), ['ap-southeast-1', 'eu-central-1']);
  assert.equal(h.calls.filter(c => !c.discovery).length, 4);
  assert.equal(h.calls.filter(c => c.discovery).length, 4);
});

test('automatic discovery finds multiple regions, skips disabled EC2 regions and accepts new AWS regions', async () => {
  const h = serviceHarness({ accounts: [{ id: 1, enabled: 1, default_region: 'us-east-1', access_key: 'fake' }],
    discover: async ({ service, command }) => {
      if (service === 'lightsail') return { regions: [{ name: 'eu-central-1' }] };
      assert.equal(command.input.AllRegions, false);
      return { Regions: [
        { RegionName: 'ap-southeast-1', OptInStatus: 'opt-in-not-required' },
        { RegionName: 'ap-southeast-9', OptInStatus: 'opted-in' },
        { RegionName: 'ap-east-1', OptInStatus: 'not-opted-in' }
      ] };
    }, send: async ({ service, region }) => service === 'ec2'
      ? { Reservations: [{ Instances: [{ InstanceId: 'i-' + region, PublicIpAddress: '192.0.2.1', State: { Name: 'running' } }] }] }
      : { instances: [{ name: 'ls-europe', state: { name: 'running' }, location: { regionName: region } }] }
  });
  const [result] = await h.aws.listAllInstances();
  assert.deepEqual(Array.from(result.discoveredRegions), ['ap-southeast-1', 'ap-southeast-9', 'eu-central-1']);
  assert.equal(result.instances.length, 3);
  assert.equal(result.status, 'ok');
  assert.ok(!h.calls.some(c => !c.discovery && ['us-east-1', 'ap-east-1'].includes(c.region)));
});

test('missing permission to enumerate regions falls back visibly without hiding accessible instances', async () => {
  const h = serviceHarness({ discover: async ({ service }) => {
    if (service === 'lightsail') return { regions: [] };
    throw Object.assign(new Error('do-not-expose-this-secret'), { name: 'UnauthorizedOperation' });
  }, send: async ({ service, region }) => ({ Reservations: service === 'ec2' && region === 'ap-southeast-1'
    ? [{ Instances: [{ InstanceId: 'i-singapore', PublicIpAddress: '192.0.2.1' }] }] : [] }) });
  const [result] = await h.aws.listAllInstances();
  assert.equal(result.status, 'partial');
  assert.equal(result.instances[0].instanceId, 'i-singapore');
  assert.equal(result.errors[0].operation, 'DescribeRegions');
  assert.equal(result.errors[0].code, 'UnauthorizedOperation');
  assert.ok(!JSON.stringify(result).includes('do-not-expose-this-secret'));
});

test('empty region directories do not invent an account home region or start a fallback scan', async () => {
  const h = serviceHarness({ discover: async ({ service }) => service === 'ec2' ? { Regions: [] } : { regions: [] } });
  const [result] = await h.aws.listAllInstances();
  assert.equal(result.status, 'ok');
  assert.equal(result.queriedRegions.length, 0);
  assert.equal(result.discoveredRegions.length, 0);
  assert.equal(h.calls.length, 2);
});

test('Lightsail directory rejection makes one Lightsail request and preserves EC2 discovery', async () => {
  const h = serviceHarness({ discover: async ({ service }) => {
    if (service === 'lightsail') throw Object.assign(new Error('fake-secret'), { name: 'AccessDeniedException' });
    return { Regions: [{ RegionName: 'ap-northeast-1' }, { RegionName: 'ap-southeast-1' }] };
  }, send: async ({ region }) => ({ Reservations: [{ Instances: [{ InstanceId: 'i-' + region, PublicIpAddress: '192.0.2.1' }] }] }) });
  const [result] = await h.aws.listAllInstances();
  assert.equal(result.instances.length, 2);
  assert.equal(result.status, 'partial');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].operation, 'GetRegions');
  assert.equal(h.calls.filter(c => c.service === 'lightsail').length, 1);
  assert.match(result.errors[0].message, /自动扫描已停止/);
  assert.ok(!JSON.stringify(result).includes('fake-secret'));
});

for (const selected of ['ec2', 'lightsail']) {
  test(`${selected}-only accounts never request the other service in automatic or manual mode`, async () => {
    for (const saved of [null, '["ap-southeast-1"]']) {
      const h = serviceHarness({ saved, accounts: [{ id: 1, enabled: 1, access_key: 'fake', query_services: JSON.stringify([selected]) }] });
      const [result] = await h.aws.listAllInstances();
      assert.ok(h.calls.length > 0);
      assert.ok(h.calls.every(c => c.service === selected));
      assert.deepEqual(Array.from(result.queryServices), [selected]);
      assert.equal(result.status, 'ok');
    }
  });
}

test('manual Lightsail queries remain available when GetRegions is denied', async () => {
  const h = serviceHarness({ saved: '["ap-southeast-1"]',
    accounts: [{ id: 1, enabled: 1, query_services: '["lightsail"]' }],
    discover: async () => { throw new Error('must not request the region directory'); },
    send: async () => ({ instances: [{ name: 'ls-allowed', state: { name: 'running' } }] })
  });
  const [result] = await h.aws.listAllInstances();
  assert.equal(result.status, 'ok');
  assert.equal(result.instances[0].instanceId, 'ls-allowed');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].discovery, false);
});

test('Lightsail-only selection of an unsupported region is not reported as a successful empty query', async () => {
  const h = serviceHarness({ saved: '["us-west-1"]', accounts: [{ id: 1, enabled: 1, query_services: '["lightsail"]' }] });
  const [result] = await h.aws.listAllInstances();
  assert.equal(h.calls.length, 0);
  assert.equal(result.status, 'error');
  assert.equal(result.errors[0].code, 'UnsupportedRegion');
});

test('automatic region enumeration is included in the refresh timeout budget', async () => {
  let aborted = 0;
  const h = serviceHarness({ discover: ({ options }) => new Promise((_, reject) => {
    options.abortSignal.addEventListener('abort', () => { aborted++; reject(Object.assign(new Error('abort'), { name: 'AbortError' })); }, { once: true });
  }) });
  const [result] = await h.aws.listAllInstances({ requestTimeoutMs: 1000, timeoutMs: 25 });
  assert.equal(result.status, 'error');
  assert.equal(aborted, 2);
  assert.equal(h.calls.filter(c => !c.discovery).length, 0);
  assert.equal(result.errors.filter(e => e.operation).length, 2);
  assert.ok(result.errors.every(e => e.code === 'TimeoutError'));
});

test('partial AWS failure keeps EC2 instances and exposes safe regional errors', async () => {
  const h = serviceHarness({ send: async ({ service }) => {
    if (service === 'lightsail') throw Object.assign(new Error('secret-in-sdk-message'), { name: 'AccessDeniedException' });
    return { Reservations: [{ Instances: [{ InstanceId: 'i-test', State: { Name: 'running' }, PublicIpAddress: '192.0.2.1' }] }] };
  } });
  const [result] = await h.aws.listAllInstances();
  assert.equal(result.status, 'partial');
  assert.equal(result.instances[0].instanceId, 'i-test');
  assert.equal(result.errors[0].service, 'lightsail');
  assert.equal(result.errors[0].code, 'AccessDeniedException');
  assert.ok(!JSON.stringify(result).includes('secret-in-sdk-message'));
});

test('all AWS failures are reported as failures, not a successful empty list', async () => {
  const h = serviceHarness({ send: async () => { throw Object.assign(new Error('fake'), { name: 'AuthFailure' }); } });
  const [result] = await h.aws.listAllInstances();
  assert.equal(result.status, 'error');
  assert.equal(result.errors.length, 2);
});

test('discovery follows EC2 and Lightsail pagination and closes clients', async () => {
  const h = serviceHarness({ send: async ({ service, command }) => {
    if (service === 'ec2') {
      const second = command.input.NextToken === 'page2';
      return { NextToken: second ? undefined : 'page2', Reservations: [{ Instances: [
        { InstanceId: second ? 'i-2' : 'i-1', PublicIpAddress: '192.0.2.1', State: { Name: 'running' } }
      ] }] };
    }
    const second = command.input.pageToken === 'page2';
    return { nextPageToken: second ? undefined : 'page2', instances: [{ name: second ? 'ls-2' : 'ls-1', state: { name: 'running' } }] };
  } });
  const [result] = await h.aws.listAllInstances();
  assert.equal(result.instances.length, 4);
  assert.equal(h.calls.filter(c => !c.discovery).length, 4);
  assert.equal(h.destroyed(), 4);
});

test('refresh caps concurrent queries and reports aborts plus unstarted work at the deadline', async () => {
  let aborted = 0;
  const h = serviceHarness({ saved: '["us-east-1","us-west-2","ap-southeast-1","eu-central-1"]',
    send: ({ options }) => new Promise((_, reject) => {
      options.abortSignal.addEventListener('abort', () => { aborted++; reject(Object.assign(new Error('abort'), { name: 'AbortError' })); }, { once: true });
    })
  });
  const [result] = await h.aws.listAllInstances({ concurrency: 2, requestTimeoutMs: 1000, timeoutMs: 25 });
  assert.equal(result.status, 'error');
  assert.equal(result.errors.length, 8);
  assert.ok(h.peak() <= 2);
  assert.equal(aborted, 2);
  assert.equal(h.calls.length, 2);
  assert.ok(result.errors.every(e => e.code === 'TimeoutError'));
});

async function routes(t, db, aws) {
  const router = loadModule('src/routes/admin/adminAws.js', {
    '../../services/database': db, '../../services/aws': aws, '../../services/deploy': {},
    '../../services/notify': {}, '../../services/logger': logger
  });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 1 }; next(); });
  app.use('/admin/api', router);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return async (url, method = 'GET', body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/api${url}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, data: await res.json() };
  };
}

test('HTTP account create/edit/read persists Singapore, validates regions and preserves proxy credentials', async t => {
  const { db } = database(t);
  const { aws } = serviceHarness({ db });
  const request = await routes(t, db, aws);
  const body = { name: 'Singapore', accessKey: 'fake-ak', secretKey: 'fake-sk', defaultRegion: 'ap-southeast-1', socks5Url: 'socks5://user:pass@localhost:1080' };
  assert.equal((await request('/aws/config', 'POST', body)).status, 200);
  const account = db.getAwsAccounts()[0];
  assert.equal(account.default_region, 'ap-southeast-1');
  assert.equal((await request('/aws/config')).data.accounts[0].defaultRegion, 'ap-southeast-1');
  assert.equal((await request(`/aws/config/${account.id}`, 'PUT', { defaultRegion: 'ap-northeast-1' })).status, 200);
  const updated = db.getAwsAccountById(account.id);
  assert.equal(updated.default_region, 'ap-northeast-1');
  assert.equal(updated.socks5_pass, 'pass');
  for (const invalid of ['', 'not-a-region', null, ['us-east-1']]) {
    assert.equal((await request('/aws/config', 'POST', { ...body, defaultRegion: invalid })).status, 400);
    assert.equal((await request(`/aws/config/${account.id}`, 'PUT', { defaultRegion: invalid })).status, 400);
  }
  assert.equal(db.getAwsAccounts().length, 1);
});

test('HTTP region settings and discovery agree for automatic, empty, explicit and reset modes', async t => {
  const { db } = database(t);
  addAccount(db);
  const h = serviceHarness({ db });
  const request = await routes(t, db, h.aws);
  assert.equal((await request('/aws/regions')).data.autoDiscover, true);
  for (const regions of [[], ['us-west-2'], null]) {
    assert.equal((await request('/aws/regions', 'POST', { regions })).status, 200);
    const setting = (await request('/aws/regions')).data;
    assert.equal(setting.autoDiscover, regions === null);
    assert.deepEqual(setting.enabled, regions || []);
    const [result] = (await request('/aws/all-instances')).data;
    assert.deepEqual(result.queriedRegions, regions || ['ap-southeast-1']);
  }
  assert.equal((await request('/aws/regions', 'POST', { regions: ['invalid'] })).status, 400);
});

test('HTTP query service settings persist, survive migrations, and immediately change scan scope', async t => {
  const { db, sqlite } = database(t);
  const h = serviceHarness({ db });
  const request = await routes(t, db, h.aws);
  const body = { name: 'services', accessKey: 'fake', secretKey: 'fake', queryServices: ['ec2'] };
  assert.equal((await request('/aws/config', 'POST', body)).status, 200);
  const account = db.getAwsAccounts()[0];
  assert.deepEqual((await request('/aws/config')).data.accounts[0].queryServices, ['ec2']);
  await request('/aws/all-instances');
  assert.ok(h.calls.every(c => c.service === 'ec2'));
  const ciphertext = sqlite.prepare('SELECT secret_key FROM aws_accounts WHERE id = ?').get(account.id).secret_key;
  assert.equal((await request(`/aws/config/${account.id}`, 'PUT', { queryServices: ['lightsail'] })).status, 200);
  h.calls.length = 0;
  await request('/aws/all-instances');
  assert.ok(h.calls.length > 0 && h.calls.every(c => c.service === 'lightsail'));
  migrate(sqlite);
  assert.equal(sqlite.prepare('SELECT secret_key FROM aws_accounts WHERE id = ?').get(account.id).secret_key, ciphertext);
  assert.deepEqual(JSON.parse(db.getAwsAccountById(account.id).query_services), ['lightsail']);
  for (const invalid of [[], null, 'ec2', ['s3'], ['ec2', 'unknown']]) {
    assert.equal((await request('/aws/config', 'POST', { ...body, queryServices: invalid })).status, 400);
    assert.equal((await request(`/aws/config/${account.id}`, 'PUT', { queryServices: invalid })).status, 400);
  }
  assert.equal(db.getAwsAccounts().length, 1);
  assert.deepEqual(JSON.parse(db.getAwsAccountById(account.id).query_services), ['lightsail']);
});

test('account/region changes invalidate cached results and partial failures never revive a successful cache', async t => {
  const { db } = database(t);
  const id = addAccount(db);
  const { aws } = serviceHarness({ db });
  let scans = 0, fail = false;
  aws.listAllInstances = async () => {
    scans++;
    return [{ accountId: id, instances: [], errors: fail ? [{ code: 'AccessDenied' }] : [] }];
  };
  const request = await routes(t, db, aws);
  await request('/aws/all-instances'); await request('/aws/all-instances');
  assert.equal(scans, 1);
  await request(`/aws/config/${id}`, 'PUT', { defaultRegion: 'us-west-2' });
  await request('/aws/all-instances'); assert.equal(scans, 2);
  fail = true;
  await request('/aws/all-instances?force=1'); await request('/aws/all-instances');
  assert.equal(scans, 4);
  fail = false;
  await request('/aws/all-instances');
  await request('/aws/config', 'POST', { name: 'new', accessKey: 'fake', secretKey: 'fake' });
  await request('/aws/all-instances'); assert.equal(scans, 6);
  await request(`/aws/config/${id}`, 'DELETE');
  await request('/aws/all-instances'); assert.equal(scans, 7);
});

test('a failed forced refresh does not serve stale cache as a successful result', async t => {
  const { db } = database(t);
  const { aws } = serviceHarness({ db });
  let fail = false;
  aws.listAllInstances = async () => { if (fail) throw new Error('fake'); return []; };
  const request = await routes(t, db, aws);
  assert.equal((await request('/aws/all-instances')).status, 200);
  fail = true;
  assert.equal((await request('/aws/all-instances?force=1')).status, 500);
  assert.equal((await request('/aws/all-instances')).status, 500);
});

test('an in-flight response cannot repopulate cache after an account edit', async t => {
  const { db } = database(t);
  const id = addAccount(db);
  const { aws } = serviceHarness({ db });
  let resolveScan, started;
  const hasStarted = new Promise(resolve => { started = resolve; });
  let scans = 0;
  aws.listAllInstances = () => {
    scans++;
    if (scans > 1) return Promise.resolve([{ instances: [], errors: [], accountName: 'new' }]);
    started();
    return new Promise(resolve => { resolveScan = resolve; });
  };
  const request = await routes(t, db, aws);
  const first = request('/aws/all-instances');
  await hasStarted;
  await request(`/aws/config/${id}`, 'PUT', { defaultRegion: 'us-west-2' });
  resolveScan([{ instances: [], errors: [], accountName: 'old' }]);
  await first;
  assert.equal((await request('/aws/all-instances')).data[0].accountName, 'new');
  assert.equal(scans, 2);
});

function browserHarness() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', innerHTML: '', textContent: '', dataset: {}, checked: false, disabled: false,
      classList: { add() {}, remove() {} }, listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; }
    });
    return elements.get(id);
  }
  const requests = [], cache = new Map();
  let nextInstances = [], fetchInstances;
  const account = { id: 1, name: 'Singapore', defaultRegion: 'ap-southeast-1',
    accessKeyMasked: 'fake***', socks5_host: 'proxy.test', socks5_port: 1080 };
  const context = { console, URL, setTimeout, clearTimeout, location: { hash: '#aws' },
    showToast() {}, toast() {}, escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    localStorage: { getItem: key => cache.get(key) || null, setItem: (key, value) => cache.set(key, value), removeItem: key => cache.delete(key) },
    document: { getElementById: element, querySelectorAll: () => [], addEventListener() {} },
    fetch: async (url, options = {}) => {
      requests.push({ url, body: options.body ? JSON.parse(options.body) : undefined, method: options.method || 'GET' });
      let data = { ok: true };
      if (url.endsWith('/regions') && !options.method) data = { all: ['us-east-1', 'ap-southeast-1'], meta: {}, enabled: [], autoDiscover: true };
      else if (url.endsWith('/config') && !options.method) data = { accounts: [account], configured: true, count: 1 };
      else if (url.includes('/all-instances')) data = fetchInstances ? await fetchInstances() : nextInstances;
      return { ok: true, json: async () => data };
    }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/admin/aws.js'), 'utf8'), context);
  return { context, element, requests, cache, setInstances: value => { nextInstances = value; },
    deferInstances: fn => { fetchInstances = fn; },
    ready: () => new Promise(resolve => setImmediate(resolve)) };
}

test('browser adds an account without a region and automatically refreshes; editing preserves proxy auth', async () => {
  const h = browserHarness();
  await h.ready();
  assert.equal(h.context._awsAccounts[0].id, 1);
  assert.match(h.element('aws-accounts').innerHTML, /自动发现实例区域/);
  h.element('aws-name').value = 'test'; h.element('aws-ak').value = 'fake'; h.element('aws-sk').value = 'fake';
  h.element('aws-query-services').value = 'ec2';
  await h.context.saveAwsConfig();
  assert.equal(Object.hasOwn(h.requests.find(r => r.method === 'POST').body, 'defaultRegion'), false);
  assert.deepEqual(h.requests.find(r => r.method === 'POST').body.queryServices, ['ec2']);
  assert.ok(h.requests.some(r => r.url.includes('/all-instances')));
  h.context.editAwsAccount(1);
  assert.equal(h.element('edit-aws-query-services').value, 'both');
  h.element('edit-aws-query-services').value = 'lightsail';
  h.element('edit-aws-name').value = 'updated';
  await h.context.saveAwsEdit();
  const edit = h.requests.find(r => r.method === 'PUT').body;
  assert.equal(edit.name, 'updated');
  assert.deepEqual(edit.queryServices, ['lightsail']);
  assert.equal(Object.hasOwn(edit, 'defaultRegion'), false);
  assert.equal(Object.hasOwn(edit, 'socks5Url'), false);
});

test('browser shows failed/partial/skipped scans accurately and escapes AWS error content', async () => {
  const h = browserHarness(); await h.ready();
  const container = h.element('aws-instances-container');
  for (const status of ['error', 'partial']) {
    h.context.renderInstances([{ accountId: 1, accountName: 'test', instances: [], status,
      errors: [{ region: '<script>', service: 'ec2', code: 'AccessDenied', message: '<secret>' }] }], container);
    assert.ok(!container.innerHTML.includes('暂无实例'));
    assert.ok(!container.innerHTML.includes('<script>'));
    assert.match(container.innerHTML, /AccessDenied/);
  }
  h.context.renderInstances([{ accountId: 1, accountName: 'test', instances: [], errors: [], status: 'skipped' }], container);
  assert.match(container.innerHTML, /未选择查询区域/);
});

test('browser collapses and groups duplicate service errors without hiding working instances', async () => {
  const h = browserHarness(); await h.ready();
  const account = { accountId: 1, accountName: 'test', status: 'partial', instances: [
    { instanceId: 'i-visible', accountId: 1, instanceType: 'ec2', name: 'Visible EC2', region: 'ap-southeast-1' }
  ], errors: ['ap-northeast-1', 'ap-southeast-1'].map(region => ({ region, service: 'lightsail', code: 'AccessDeniedException', message: 'test failure' })) };
  const container = h.element('aws-instances-container');
  h.context.renderInstances([account], container);
  assert.match(container.innerHTML, /已显示 1 个实例；Lightsail 查询未完成/);
  assert.match(container.innerHTML, /<details /);
  assert.ok(!/<details[^>]*\bopen\b/.test(container.innerHTML));
  assert.equal((container.innerHTML.match(/AccessDeniedException/g) || []).length, 1);
  assert.match(container.innerHTML, /Visible EC2/);
  assert.match(container.innerHTML, /ap-northeast-1, ap-southeast-1/);
  assert.match(container.innerHTML, /编辑此账号的查询服务/);
});

test('browser caches successful scans only and ignores responses from before a configuration change', async () => {
  const h = browserHarness(); await h.ready();
  h.setInstances([{ accountId: 1, accountName: 'test', status: 'ok', instances: [], errors: [] }]);
  await h.context.loadAllInstances(true);
  assert.equal(h.cache.size, 1);
  h.setInstances([{ accountId: 1, accountName: 'test', status: 'error', instances: [], errors: [{ service: 'ec2', code: 'AccessDenied' }] }]);
  await h.context.loadAllInstances(true);
  assert.equal(h.cache.size, 0);
  let finish;
  h.deferInstances(() => new Promise(resolve => { finish = resolve; }));
  const refresh = h.context.loadAllInstances(true);
  h.context.invalidateAwsInstancesCache();
  finish([{ accountId: 1, accountName: 'old', status: 'ok', instances: [], errors: [] }]);
  await refresh;
  assert.equal(h.cache.size, 0);
  assert.match(h.element('aws-instances-container').textContent, /配置已更新/);
});

test('browser region selector distinguishes automatic discovery and explicit empty selections', async () => {
  const h = browserHarness(); await h.ready();
  assert.equal(h.element('aws-regions-auto').checked, true);
  await h.element('btn-aws-regions-save').listeners.click();
  assert.equal(h.requests.filter(r => r.method === 'POST').at(-1).body.regions, null);
  h.element('btn-aws-regions-none').listeners.click();
  await h.element('btn-aws-regions-save').listeners.click();
  assert.deepEqual(h.requests.filter(r => r.method === 'POST').at(-1).body.regions, []);
});
