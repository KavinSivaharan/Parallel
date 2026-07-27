const SECRET_ASSIGNMENT =
  /\b(api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret|cookie)\b(\s*[:=]\s*)(["']?)[^\s"',;]+/gi;
const BEARER_TOKEN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const OPENAI_KEY = /\b(sk-[A-Za-z0-9_-]{12,})\b/g;

export function redactProviderText(value: string, maxBytes = 65_536): string {
  const redacted = value
    .replace(BEARER_TOKEN, "$1[REDACTED]")
    .replace(SECRET_ASSIGNMENT, "$1$2$3[REDACTED]")
    .replace(OPENAI_KEY, "[REDACTED]");
  return truncateUtf8(redacted, maxBytes);
}

export function providerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TERM",
    "CODEX_HOME",
    "XDG_CONFIG_HOME",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
  ] as const;
  const environment: NodeJS.ProcessEnv = {
    PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: source.HOME,
    LANG: source.LANG ?? "C.UTF-8",
    LC_ALL: source.LC_ALL ?? "C.UTF-8",
    TMPDIR: source.TMPDIR ?? "/tmp",
    CI: "true",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of allowed) {
    const value = source[key];
    if (value) environment[key] = value;
  }
  return environment;
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoded = Buffer.from(value);
  if (encoded.byteLength <= maxBytes) return value;
  if (maxBytes <= 32) return encoded.subarray(0, maxBytes).toString("utf8");
  return `${encoded.subarray(0, Math.max(0, maxBytes - 32)).toString("utf8")}\n[truncated by Parallel]`;
}
