import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DomainError } from './domain-error.js';
import type { CheckResult, EvolutionCase, EvolutionFile } from './evolution-contracts.js';
export function relativeFile(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200 || !/^[\w-]+(?:[\w./ -]*[\w.-])?$/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.')) || !/\.(md|txt|json|csv)$/i.test(value)) throw new DomainError('仅允许相对路径的 md/txt/json/csv 文件，不允许隐藏文件或路径穿越。');
  return value;
}
export function safeFile(root: string, path: string): string {
  const base = realpathSync(root); const target = resolve(base, relativeFile(path));
  if (!target.startsWith(base + sep)) throw new DomainError('文件越界。');
  let current = base;
  for (const part of path.split('/')) { current = join(current, part); if (existsSync(current) || (() => { try { lstatSync(current); return true; } catch { return false; } })()) { const s = lstatSync(current); if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile())) throw new DomainError('文件路径不允许链接或特殊文件。'); } }
  return target;
}
export function parseFiles(value: unknown, max = 30): EvolutionFile[] {
  if (!Array.isArray(value) || value.length > max) throw new DomainError(`文件数不能超过 ${max}。`);
  const files = value.map(v => { if (!v || typeof v.text !== 'string' || v.text.length > 30_000 || v.text.includes('\0')) throw new DomainError('文件文本无效或超过 30000 字符。'); return { path: relativeFile(v.path), text: v.text }; });
  if (new Set(files.map(f => f.path)).size !== files.length || files.reduce((n, f) => n + f.text.length, 0) > 100_000) throw new DomainError('文件重复或总文本超过 100000 字符。');
  return files;
}
export function writeFiles(root: string, files: EvolutionFile[]) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const f of files) { const path = safeFile(root, f.path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, f.text, { mode: 0o600 }); }
}
export function collectFiles(root: string): EvolutionFile[] {
  const files: EvolutionFile[] = []; let size = 0;
  const walk = (path: string, prefix = '') => {
    for (const entry of readdirSync(path)) {
      const rel = prefix + entry, full = join(path, entry), stat = lstatSync(full);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('产物包含链接或特殊文件。');
      if (stat.isDirectory()) { if (rel.split('/').length > 8) throw new Error('产物目录过深。'); walk(full, rel + '/'); }
      else { relativeFile(rel); size += stat.size; if (stat.size > 100_000 || size > 500_000 || files.length >= 60) throw new Error('产物超过数量或体积限制。'); files.push({ path: rel, text: readFileSync(full, 'utf8') }); }
    }
  }; walk(root); return files.sort((a, b) => a.path.localeCompare(b.path));
}
export function parseCases(value: unknown): EvolutionCase[] {
  if (!Array.isArray(value) || !value.length || value.length > 8) throw new DomainError('请提供 1–8 条回归 Case。');
  return value.map((v, i) => {
    if (!v || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 100 || typeof v.prompt !== 'string' || !v.prompt.trim() || v.prompt.length > 8000 || !Array.isArray(v.checks) || !v.checks.length || v.checks.length > 20) throw new DomainError('Case 需要名称、任务和 1–20 条验收断言。');
    const checks = v.checks.map((c: any) => {
      if (!c || !['exists', 'text', 'json'].includes(c.kind)) throw new DomainError('断言类型须为 exists/text/json。');
      const path = relativeFile(c.path);
      if (c.kind !== 'exists' && (typeof c.expected !== 'string' || c.expected.length > 30_000)) throw new DomainError('text/json 断言需要 expected 文本。');
      if (c.kind === 'json') { try { JSON.parse(c.expected); } catch { throw new DomainError('JSON 断言值无效。'); } }
      return { path, kind: c.kind, ...(c.kind !== 'exists' ? { expected: c.expected } : {}) };
    });
    if (!checks.some((c: any) => c.kind !== 'exists')) throw new DomainError('每条 Case 至少需要一条内容断言，不能只检查文件存在。');
    return { id: `c${i + 1}`, name: v.name.trim(), prompt: v.prompt.trim(), fixtures: parseFiles(v.fixtures ?? []), checks };
  });
}
export function checkArtifacts(root: string, test: EvolutionCase): CheckResult[] {
  return test.checks.map(check => {
    let passed = false, reason = '文件不存在';
    try {
      const path = safeFile(root, check.path);
      if (existsSync(path) && lstatSync(path).isFile()) {
        if (lstatSync(path).size > 100_000) throw new Error('文件超过验收大小限制');
        const text = readFileSync(path, 'utf8');
        passed = check.kind === 'exists' || (check.kind === 'text' ? text === check.expected : isDeepStrictEqual(JSON.parse(text), JSON.parse(check.expected!)));
        reason = passed ? '程序验收通过' : '文件内容与预期不一致';
      }
    } catch { reason = '文件路径、类型或 JSON 格式无效'; }
    return { path: check.path, kind: check.kind, passed, reason };
  });
}
