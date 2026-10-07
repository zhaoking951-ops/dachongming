const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Writable } = require('node:stream');
const { getRealitySni } = require('../src/utils/reality');
const subscriptions = require('../src/utils/vless');

process.env.SESSION_SECRET ||= 'reality-sni-test-session-secret-only';

function setSni(t, value) {
  const previous = process.env.REALITY_SNI;
  if (value === undefined) delete process.env.REALITY_SNI;
  else process.env.REALITY_SNI = value;
  t.after(() => {
    if (previous === undefined) delete process.env.REALITY_SNI;
    else process.env.REALITY_SNI = previous;
  });
}

// Load the real module with only external side effects replaced.
function loadModule(relativePath, mocks) {
  const filename = path.resolve(__dirname, relativePath);
  const realRequire = createRequire(filename);
  const context = {
    module: { exports: {} }, process, Buffer, URL, AbortController, setTimeout, clearTimeout,
    __dirname: path.dirname(filename),
    require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : realRequire(name),
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context.module.exports;
}

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const nodeTemplate = {
  id: 1, protocol: 'vless', host: '127.0.0.1', port: 19723, name: 'test-node',
  uuid: '00000000-0000-4000-8000-000000000001',
  reality_private_key: 'test-private-key', reality_public_key: 'test-public-key',
  reality_short_id: '1234abcd',
};

function assertSubscriptions(node, expected) {
  const link = new URL(subscriptions.buildVlessLink(node));
  assert.equal(link.searchParams.get('sni'), expected);
  assert.equal(link.searchParams.get('pbk'), node.reality_public_key);
  assert.equal(link.searchParams.get('sid'), node.reality_short_id);
  assert.equal(link.searchParams.get('flow'), 'xtls-rprx-vision');
  for (const mixed of [false, true]) {
    const v2ray = mixed ? subscriptions.generateV2rayAllSub([node], [])
      : subscriptions.generateV2raySubForUser([node]);
    assert.equal(new URL(Buffer.from(v2ray, 'base64').toString()).searchParams.get('sni'), expected);
    const clash = mixed ? subscriptions.generateClashAllSub([node], [])
      : subscriptions.generateClashSubForUser([node]);
    assert.ok(clash.includes(`servername: "${expected}"`));
    const singbox = JSON.parse(mixed ? subscriptions.generateSingboxAllSub([node], [])
      : subscriptions.generateSingboxSubForUser([node]));
    const outbound = singbox.outbounds.find(o => o.type === 'vless');
    assert.equal(outbound.tls.server_name, expected);
    assert.equal(outbound.tls.reality.public_key, node.reality_public_key);
    assert.equal(outbound.tls.reality.short_id, node.reality_short_id);
    assert.equal(outbound.flow, 'xtls-rprx-vision');
  }
}

function assertConfig(config, node, expected) {
  const inbound = config.inbounds.find(i => i.protocol === 'vless');
  const reality = inbound.streamSettings.realitySettings;
  assert.equal(reality.dest, `${expected}:443`);
  assert.deepEqual(Array.from(reality.serverNames), [expected]);
  assert.equal(reality.privateKey, node.reality_private_key);
  assert.deepEqual(Array.from(reality.shortIds), [node.reality_short_id]);
  assert.equal(inbound.settings.clients[0].flow, 'xtls-rprx-vision');
}

for (const [label, env, saved, expected] of [
  ['unset', undefined, undefined, 'www.bing.com'],
  ['empty', '', null, 'www.bing.com'],
  ['blank', '  ', '', 'www.bing.com'],
  ['custom', ' target.example.org ', undefined, 'target.example.org'],
  ['saved node', 'target.example.org', 'gateway.icloud.com', 'gateway.icloud.com'],
  ['explicit legacy node', undefined, 'www.microsoft.com', 'www.microsoft.com'],
]) {
  test(`Reality SNI ${label}: subscriptions and every sync path agree`, async (t) => {
    setSni(t, env);
    const node = { ...nodeTemplate, sni: saved };
    assert.equal(getRealitySni(saved), expected);
    assertSubscriptions(node, expected);
    const configs = [];
    const deploy = loadModule('../src/services/deploy.js', {
      './logger': logger, './notify': { notify: {} },
      './agent-ws': {
        isAgentOnline: () => true,
        sendCommand: async (_id, command) => { configs.push(command.config); return { success: true }; },
      },
    });
    const peer = { id: 2, protocol: 'ss', host: node.host, port: 19724 };
    for (const [target, nodes] of [[node, [node]], [node, [node, peer]], [peer, [node, peer]]]) {
      const db = { getAllNodes: () => nodes, getNodeAllUserUuids: () => [{ uuid: node.uuid, user_id: 1 }] };
      assert.equal(await deploy.syncNodeConfig(target, db), true);
      assertConfig(configs.at(-1), node, expected);
    }
    assert.equal(configs.length, 3);
  });
}

for (const env of [undefined, 'target.example.org']) {
  for (const method of ['deployNode', 'deployDualNode']) {
    test(`${method} persists ${env || 'default'} SNI in DB and Xray`, async (t) => {
      setSni(t, env);
      const nodes = [];
      const configs = [];
      class MockSSH {
        async connect() {}
        dispose() {}
        async execCommand(command) {
          let stdout = 'INSTALL_OK DEPLOY_OK';
          if (command === 'xray x25519') stdout = 'PrivateKey: test-private-key\nPassword: test-public-key';
          if (command.startsWith('ip -6 addr')) stdout = '2001:db8::1';
          return { code: 0, stdout, stderr: '' };
        }
        async requestSFTP() {
          return { createWriteStream: () => new Writable({
            write(chunk, _encoding, done) { configs.push(JSON.parse(chunk.toString())); done(); },
          }) };
        }
      }
      const deploy = loadModule('../src/services/deploy.js', {
        'node-ssh': { NodeSSH: MockSSH }, './logger': logger, './notify': { notify: { deploy() {} } },
      });
      const db = {
        getAllNodes: () => nodes,
        addNode: (data) => { nodes.push({ ...data, id: nodes.length + 1 }); return { lastInsertRowid: nodes.length }; },
        updateNode: (id, data) => Object.assign(nodes.find(n => n.id === id), data),
        getNodeById: (id) => nodes.find(n => n.id === id),
        getSetting: () => null,
        getNodeAllUserUuids: () => [{ uuid: nodeTemplate.uuid, user_id: 1 }],
        getDb: () => ({ transaction: fn => fn }),
        ensureAllUsersHaveUuid() {}, addAuditLog() {},
      };
      await deploy[method]({ host: '127.0.0.1' }, db);
      const node = nodes[0];
      const expected = env || 'www.bing.com';
      assert.equal(node.sni, expected);
      assert.equal(node.is_active, 1);
      assert.equal(configs.length, 1);
      assertConfig(configs[0], node, expected);
      assertSubscriptions(node, expected);
    });
  }
}

test('migrations set the new schema default and preserve existing node SNI values', (t) => {
  setSni(t, 'target.example.org');
  const Database = require('better-sqlite3');
  const sqlite = new Database(':memory:');
  t.after(() => sqlite.close());
  const database = loadModule('../src/services/database.js', {
    'better-sqlite3': function MemoryDatabase() { return sqlite; },
    fs: { mkdirSync() {} },
  });
  database.getDb();
  const sniColumn = sqlite.prepare('PRAGMA table_info(nodes)').all().find(c => c.name === 'sni');
  assert.equal(sniColumn.dflt_value, "'www.bing.com'");
  for (const [id, sni] of [[1, 'gateway.icloud.com'], [2, 'www.microsoft.com'], [3, null]]) {
    sqlite.prepare('INSERT INTO nodes (id, name, host, port, uuid, sni) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, `node-${id}`, '127.0.0.1', 19723 + id, `uuid-${id}`, sni);
  }
  const before = sqlite.prepare('SELECT id, sni FROM nodes ORDER BY id').all();
  require('../src/services/migrations').runMigrations(sqlite);
  assert.deepEqual(sqlite.prepare('SELECT id, sni FROM nodes ORDER BY id').all(), before);
});
