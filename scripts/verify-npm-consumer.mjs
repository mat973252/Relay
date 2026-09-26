// Run against a clean npm install, never against workspace symlinks.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const consumer = resolve(process.argv[2]);
const cli = join(consumer, 'node_modules/@mat973252/relay-cli/dist/src/cli.js');
const main = join(consumer, 'node_modules/@mat973252/relay-mcp/dist/src/main.js');
assert.match(execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }), /relay effects/);
const workspace = await mkdtemp(join(tmpdir(), 'relay-npm-smoke-'));
let posts = 0;
let complete = false;
const provider = createServer((req, res) => {
  assert.equal(req.url, '/exports/smoke-1');
  if (req.method === 'POST') { posts++; res.statusCode = 202; }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: complete ? 'complete' : 'pending' }));
});
provider.listen(0, '127.0.0.1');
await once(provider, 'listening');
const url = `http://127.0.0.1:${provider.address().port}/exports/{operationId}`;
let child;
let lines;
const pending = new Map();
let nextId = 0;
try {
  await mkdir(join(workspace, '.relay'));
  await writeFile(join(workspace, '.relay/mcp-actions.json'), JSON.stringify({
    schema: 'relay.mcp-actions/1', actions: [{ id: 'export-orders', label: 'Synthetic export',
      http: { method: 'POST', url }, reconcile: { url, shape: 'status-field' } }],
  }));
  child = spawn(process.execPath, [main, '--workspace', workspace], { stdio: ['pipe', 'pipe', 'inherit'] });
  lines = createInterface({ input: child.stdout });
  lines.on('line', line => { const msg = JSON.parse(line); pending.get(msg.id)?.(msg); });
  const request = (method, params) => new Promise((resolveRequest, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 10000);
    pending.set(id, msg => { clearTimeout(timer); pending.delete(id); resolveRequest(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  assert.equal(init.result.serverInfo.name, 'relay');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = await request('tools/list', {});
  assert.ok(tools.result.tools.some(t => t.name === 'relay_reconcile_operation'));
  const args = { actionId: 'export-orders', operationId: 'smoke-1' };
  const call = (name, arguments_) => request('tools/call', { name, arguments: arguments_ });
  const outcome = response => {
    assert.equal(response.result.isError ?? false, false);
    return JSON.parse(response.result.content[0].text.split('\n')[0]);
  };
  assert.equal(outcome(await call('relay_submit_action', args)).status, 'unknown');
  assert.match(JSON.stringify(await call('relay_list_unresolved', {})), /smoke-1/);
  assert.equal(outcome(await call('relay_submit_action', args)).status, 'unknown');
  complete = true;
  assert.equal(outcome(await call('relay_reconcile_operation', args)).status, 'confirmed');
  await call('relay_submit_action', args);
  assert.equal(posts, 1, 'one POST despite repeated submit');
  const history = execFileSync(process.execPath, [cli, 'effects', '--history', '--json'], { cwd: workspace, encoding: 'utf8' });
  assert.match(history, /CONFIRMED/);
  console.log('PASS installed CLI + MCP initialize/list/submit/pending/reconcile/history; POST=1');
} finally {
  lines?.close();
  if (child && child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
  provider.closeAllConnections();
  await new Promise(resolveClose => provider.close(resolveClose));
  await rm(workspace, { recursive: true, force: true });
}
