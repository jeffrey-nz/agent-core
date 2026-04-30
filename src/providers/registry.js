export const PROVIDERS = [
  {
    value: "openai-api",
    label: "OpenAI GPT-4o (Direct API)",
    shortLabel: "GPT-4o API",
    limits: { soft: 30, hard: 40 },
    isDirectApi: true,
  },
  {
    value: "copilot",
    label: "Microsoft Copilot",
    shortLabel: "Copilot",
    limits: { soft: 18, hard: 26 },
  },
  {
    value: "copilot365",
    label: "Microsoft Copilot 365",
    shortLabel: "Copilot 365",
    limits: { soft: 18, hard: 26 },
  },
  {
    value: "gemini",
    label: "Google Gemini",
    shortLabel: "Gemini",
    limits: { soft: 40, hard: 50 },
  },
  {
    value: "chatgpt",
    label: "OpenAI ChatGPT",
    shortLabel: "ChatGPT",
    limits: { soft: 30, hard: 40 },
  },
  {
    value: "deepseek",
    label: "DeepSeek Chat",
    shortLabel: "DeepSeek",
    limits: { soft: 35, hard: 45 },
  },
  {
    value: "grok",
    label: "xAI Grok",
    shortLabel: "Grok",
    limits: { soft: 30, hard: 40 },
  },
];

export const PROVIDER_VALUES = PROVIDERS.map((p) => p.value);

export const PROVIDER_LIMITS = Object.fromEntries(
  PROVIDERS.map((p) => [p.value, p.limits]),
);

export const PROVIDER_LABELS = Object.fromEntries(
  PROVIDERS.map((p) => [p.value, p.label]),
);

export const PROVIDER_SHORT_LABELS = Object.fromEntries(
  PROVIDERS.map((p) => [p.value, p.shortLabel]),
);

export const PROVIDER_CLI_LABELS = Object.fromEntries(
  PROVIDERS.map((p) => [p.value, p.label + " (via API)"]),
);
