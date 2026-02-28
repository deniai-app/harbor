import { readFile } from "node:fs/promises";

export interface AppConfig {
  port: number;
  baseUrl: string;
  github: {
    appId: string;
    privateKey: string;
    webhookSecret: string;
    reviewTriggerMention: string;
  };
  llm: {
    provider: string;
    model: string;
    openaiApiKey?: string;
  };
  virtualIde: {
    allowConfigRead: boolean;
  };
}

const DEFAULT_PORT = 8787;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}


function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

async function loadPrivateKey(): Promise<string> {
  if (process.env.GITHUB_PRIVATE_KEY_PEM) {
    return process.env.GITHUB_PRIVATE_KEY_PEM.replace(/\\n/g, "\n").trim();
  }

  if (process.env.GITHUB_PRIVATE_KEY_PATH) {
    const key = await readFile(process.env.GITHUB_PRIVATE_KEY_PATH, "utf-8");
    return key.trim();
  }

  throw new Error(
    "Missing GitHub private key. Set GITHUB_PRIVATE_KEY_PEM or GITHUB_PRIVATE_KEY_PATH.",
  );
}

export async function loadConfigFromEnv(): Promise<AppConfig> {
  const privateKey = await loadPrivateKey();

  return {
    port: Number.parseInt(process.env.PORT ?? `${DEFAULT_PORT}`, 10),
    baseUrl: process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? DEFAULT_PORT}`,
    github: {
      appId: requireEnv("GITHUB_APP_ID"),
      privateKey,
      webhookSecret: requireEnv("GITHUB_WEBHOOK_SECRET"),
      reviewTriggerMention: process.env.GITHUB_REVIEW_TRIGGER_MENTION ?? "@deniai-app",
    },
    llm: {
      provider: process.env.LLM_PROVIDER ?? "openai",
      model: process.env.LLM_MODEL ?? "gpt-5.2-codex",
      openaiApiKey: process.env.OPENAI_API_KEY,
    },
    virtualIde: {
      allowConfigRead: parseBoolean(process.env.VIRTUAL_IDE_ALLOW_CONFIG_READ, false),
    },
  };
}
