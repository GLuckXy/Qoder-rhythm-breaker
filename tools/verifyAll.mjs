// tools/verifyAll.mjs — Owner: leader（编排者）。agent 不得修改本文件。
// 聚合四道门禁：contract(CORE) / level(SOUND) / audio(SOUND) / render(WORLD)。
// 约定：每个 check 脚本最后一行必须打印 `RESULT: PASS|FAIL|SKIP <细节>`，否则本聚合器判 FAIL(no-result-line)。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const checks = [
  ['contract', 'tools/contractTest.mjs'],
  ['level', 'tools/checkLevel.mjs'],
  ['audio', 'tools/audioAssert.mjs'],
  ['render', 'tools/screenshotCheck.mjs']
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const verbose = process.argv.includes('--verbose');
const rows = [];

for (const [name, script] of checks) {
  if (only.length && !only.includes(name)) continue;
  const r = spawnSync(process.execPath, [join(root, script), '--json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = out.match(/RESULT:\s*(PASS|FAIL|SKIP)\s*(.*)/i);
  let status = 'FAIL';
  let detail = 'no-result-line';
  if (m) {
    status = m[1].toUpperCase();
    detail = m[2].trim() || '-';
  } else if (r.error?.code === 'MODULE_NOT_FOUND' || /Cannot find module/.test(out)) {
    status = 'SKIP';
    detail = 'tool not implemented yet';
  }
  if (r.status === null && status === 'FAIL') detail = `timeout/signal ${r.signal}`;
  rows.push({ name, status, detail, out });
}

for (const row of rows) {
  const icon = row.status === 'PASS' ? 'OK  ' : row.status === 'SKIP' ? 'SKIP' : 'FAIL';
  console.log(`[${icon}] ${row.name.padEnd(9)} ${row.detail}`);
  if (verbose && row.status !== 'PASS') console.log(row.out.split('\n').map((l) => '      ' + l).join('\n'));
}

const failed = rows.filter((r) => r.status === 'FAIL');
const skipped = rows.filter((r) => r.status === 'SKIP');
console.log(
  `\nverify:all -> ${rows.length - failed.length - skipped.length}/${rows.length} PASS, ` +
    `${skipped.length} SKIP, ${failed.length} FAIL`
);
process.exit(failed.length ? 1 : 0);
