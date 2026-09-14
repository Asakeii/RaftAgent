// 查看器不导出二进制、签名和凭据；文本限制也约束大型工具结果。
export function redact(value: unknown, secrets: string[] = [], depth = 0): unknown {
  if (depth > 12) return '[嵌套内容已截断]';
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets.filter(Boolean)) text = text.replaceAll(secret, '[REDACTED]');
    text = text.replace(/\bBearer\s+[\w.+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[\w-]{12,}/g, '[REDACTED]')
      .replace(/((?:api[_-]?key|authorization|password|access[_-]?token|RAFT_RUN_TOKEN)\s*[=:]\s*["']?)[^\s"',;}]+/gi, '$1[REDACTED]');
    return text.length > 24_000 ? text.slice(0, 24_000) + '\n[内容超过 24000 字符，已截断]' : text;
  }
  if (Array.isArray(value)) return value.slice(0, 100).map(v => redact(v, secrets, depth + 1)).concat(value.length > 100 ? ['[其余条目已截断]'] : []);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([k, v]) => [k, /^(?:api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token|token|RAFT_RUN_TOKEN|signature|data)$/i.test(k) ? '[REDACTED]' : redact(v, secrets, depth + 1)]));
  return value;
}
export const inspectionText = (value: unknown, secrets: string[] = []) => {
  const safe = redact(value, secrets);
  const text = typeof safe === 'string' ? safe : String(JSON.stringify(safe, null, 2) ?? '');
  return text.length > 24_000 ? text.slice(0, 24_000) + '\n[内容超过 24000 字符，已截断]' : text;
};
