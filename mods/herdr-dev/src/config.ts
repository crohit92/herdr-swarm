// .env parsing and the rules for the settings herdr-dev needs. Same rules as scripts/dev-lib.ts.

export function parseEnv(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    vars[key] = value;
  }
  return vars;
}

export type ProjectSettings = {
  intervalSeconds: number;
  baseBranch: string;
  maxAttempts: number;
};

// Throws an Error that names every missing or invalid key.
export function readProjectSettings(env: Record<string, string>): ProjectSettings {
  const errors: string[] = [];
  const interval = Number(env.HERDR_DEV_INTERVAL_SECONDS);
  if (!env.HERDR_DEV_INTERVAL_SECONDS) errors.push("HERDR_DEV_INTERVAL_SECONDS is required");
  else if (!Number.isInteger(interval) || interval < 30) errors.push("HERDR_DEV_INTERVAL_SECONDS must be an integer of at least 30");

  const maxAttempts = env.HERDR_DEV_MAX_ATTEMPTS ? Number(env.HERDR_DEV_MAX_ATTEMPTS) : 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) errors.push("HERDR_DEV_MAX_ATTEMPTS must be a positive integer");

  if (!env.AZURE_DEVOPS_ORG) errors.push("AZURE_DEVOPS_ORG is required");
  if (!env.AZURE_DEVOPS_PROJECT) errors.push("AZURE_DEVOPS_PROJECT is required");

  if (errors.length > 0) throw new Error(errors.join("; "));
  return {
    intervalSeconds: interval,
    baseBranch: env.HERDR_DEV_BASE_BRANCH || "main",
    maxAttempts,
  };
}
