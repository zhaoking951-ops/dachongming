const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');

const bash = process.env.BASH || (process.platform === 'win32'
  ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : 'bash');
const bashAvailable = spawnSync(bash, ['--version']).status === 0;
const source = fs.readFileSync(path.join(__dirname, '../install.sh'), 'utf8')
  .replace(/\r\n/g, '\n').replace(/^main "\$@"\s*$/m, '');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reality-installer-'));
  t.after(() => {
    assert.equal(path.dirname(dir), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('reality-installer-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(dir, 'installer.sh'), source);
  return dir;
}

function run(dir, commands, env = {}) {
  const childEnv = { ...process.env };
  delete childEnv.REALITY_SNI;
  delete childEnv.REPO_URL;
  const result = spawnSync(bash, ['--noprofile', '--norc'], {
    cwd: dir, encoding: 'utf8', timeout: 15000,
    env: { ...childEnv, ...env },
    input: `source ./installer.sh\nINSTALL_DIR="$PWD"\n${commands}\n`,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  return result.stdout;
}

for (const [label, initial, env, expected] of [
  ['missing', '', {}, 'www.bing.com'],
  ['custom', 'REALITY_SNI=gateway.icloud.com\n', {}, 'gateway.icloud.com'],
  ['empty but explicit', 'REALITY_SNI=\n', {}, ''],
  ['exported and spaced', ' export REALITY_SNI = "target.example.org"\n', {}, 'target.example.org'],
  ['environment default', '', { REALITY_SNI: 'custom.example.org' }, 'custom.example.org'],
  ['existing wins over environment', 'REALITY_SNI=gateway.icloud.com\n', { REALITY_SNI: 'custom.example.org' }, 'gateway.icloud.com'],
]) {
  test(`installer existing .env: ${label}, repeated runs do not duplicate SNI`, { skip: !bashAvailable }, (t) => {
    const dir = fixture(t);
    const original = `PANEL_DOMAIN=panel.example.org\n${initial}KEEP_ME=unchanged`;
    fs.writeFileSync(path.join(dir, '.env'), original);
    run(dir, 'configure_env\nconfigure_env', env);
    const content = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    assert.ok(content.startsWith(original));
    assert.equal(dotenv.parse(content).REALITY_SNI, expected);
    assert.equal((content.match(/^\s*(?:export\s+)?REALITY_SNI\s*=/gm) || []).length, 1);
  });
}

for (const custom of [undefined, 'custom.example.org']) {
  test(`installer new .env: ${custom || 'default'}`, { skip: !bashAvailable }, (t) => {
    const dir = fixture(t);
    run(dir, "configure_env <<'ANSWERS'\npanel.example.org\n\nANSWERS", custom ? { REALITY_SNI: custom } : {});
    const content = dotenv.parse(fs.readFileSync(path.join(dir, '.env')));
    assert.equal(content.REALITY_SNI, custom || 'www.bing.com');
  });
}

for (const answer of ['', 'n', 'N']) {
  test(`installer continues after skipping optional OpenClaw: ${answer || 'Enter'}`, { skip: !bashAvailable }, (t) => {
    const dir = fixture(t);
    const output = run(dir, `setup_openclaw <<'ANSWERS'\n${answer}\nANSWERS\nprintf 'INSTALL_FINISHED\\n'`);
    assert.ok(output.includes('INSTALL_FINISHED'));
  });
}

test('installer defaults to the owned repository, accepts a custom URL and preserves origin on update', { skip: !bashAvailable }, (t) => {
  const dir = fixture(t);
  const stubs = `
git() { printf '%s\\n' "$*" >> commands.log; }
npm() { :; }
deploy_code
`;
  run(dir, stubs);
  assert.match(fs.readFileSync(path.join(dir, 'commands.log'), 'utf8'), /clone --depth 1 https:\/\/github.com\/zhaoking951-ops\/dachongming\.git/);
  fs.writeFileSync(path.join(dir, 'commands.log'), '');
  run(dir, stubs, { REPO_URL: 'https://github.com/example/fork.git' });
  assert.match(fs.readFileSync(path.join(dir, 'commands.log'), 'utf8'), /clone --depth 1 https:\/\/github.com\/example\/fork\.git/);
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, 'commands.log'), '');
  run(dir, stubs, { REPO_URL: 'https://github.com/example/different.git' });
  const commands = fs.readFileSync(path.join(dir, 'commands.log'), 'utf8').trim().split('\n');
  assert.deepEqual(commands, ['fetch origin main --quiet', 'reset --hard origin/main --quiet']);
});
