// Validate the shipped host templates without credentials or a model account.
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'relay-hosts-'));
try {
  await cp(join(root, 'hosts'), join(temp, 'hosts'), { recursive: true });
  const plugin = join(temp, 'hosts/claude-code/relay-effect-guard');
  const manifest = JSON.parse(await readFile(join(plugin, '.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'relay-effect-guard');
  assert.equal(manifest.version, '0.1.0');
  const workspace = join(temp, 'workspace with spaces');
  execFileSync(process.execPath, [join(plugin, 'install.mjs'), workspace]);
  const config = JSON.parse(await readFile(join(plugin, '.mcp.json'), 'utf8'));
  assert.deepEqual(config.mcpServers.relay, {
    command: process.execPath,
    args: [resolve(temp, 'packages/mcp/dist/src/main.js'), '--workspace', workspace],
    env: {},
  });
  for (const path of [
    'hosts/claude-code/relay-effect-guard/skills/relay-safe-actions/SKILL.md',
    'hosts/codex/relay-effect-guard/SKILL.md',
  ]) {
    const skill = await readFile(join(temp, path), 'utf8');
    for (const tool of ['relay_list_unresolved', 'relay_submit_action', 'relay_reconcile_operation']) {
      assert.ok(skill.includes(tool), `${path}: missing ${tool}`);
    }
    assert.match(skill, /UNKNOWN/);
  }
  console.log('PASS host template configuration (no live host/model calls)');
} finally {
  await rm(temp, { recursive: true, force: true });
}
