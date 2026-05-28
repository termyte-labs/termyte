const SECRET_KEY_RE = /(token|secret|password|passwd|pass|apikey|api_key|authorization|bearer|privatekey|clientsecret)/i;

export function redactCommand(command: string): string {
  const normalized = command
    .replace(/(--?(?:token|secret|password|passwd|pass|apikey|api-key|api_key|auth|authorization))\s+(["']?)[^\s"']+\2/gi, "$1 [REDACTED]")
    .replace(/(--?(?:token|secret|password|passwd|pass|apikey|api-key|api_key|auth|authorization))=([^\s]+)/gi, "$1=[REDACTED]")
    .replace(/(\b[a-zA-Z_][a-zA-Z0-9_]*\b)=([^\s]+)/g, (match, key: string, value: string) =>
      SECRET_KEY_RE.test(key) ? `${key}=[REDACTED]` : match,
    )
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(Basic\s+)[A-Za-z0-9+/=]+/gi, "$1[REDACTED]");

  return normalized;
}

export function redactEnvKeys(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).sort();
}
