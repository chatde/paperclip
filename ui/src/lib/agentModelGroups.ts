// Groups agents by the AI provider and model they run on, for the Agents
// "By model" tab. Derived only from adapterType and the non-secret
// adapterConfig.provider / adapterConfig.model fields; env is never read.
// Lookups use Maps so a persisted provider like "__proto__" is just unknown.

export interface AgentModelGroupInput {
  id: string;
  adapterType: string;
  adapterConfig?: Record<string, unknown> | null;
}

export interface AgentModelGroup<A extends AgentModelGroupInput> {
  provider: string;
  count: number;
  models: { model: string; agents: A[] }[];
}

// Provider ids as adapters persist them (hermes `provider`, paperclip_runner
// `provider`, Pi/OpenCode `provider/model` prefixes), mapped to display names.
const PROVIDER_NAMES = new Map<string, string>([
  ["xiaomi", "MiMo"],
  ["minimax", "MiniMax"],
  ["nvidia", "NVIDIA"],
  ["gemini", "Gemini"],
  ["google", "Gemini"],
  ["xai", "Grok"],
  ["grok", "Grok"],
  ["anthropic", "Claude"],
  ["claude", "Claude"],
  ["claude_managed", "Claude"],
  ["codex", "Codex"],
  ["openai", "OpenAI"],
  ["openrouter", "OpenRouter"],
]);

// Clients that route to a separate AI provider and write `model` as `provider/model`
// (pi-local / opencode-local execute.ts parseModelProvider; the native runner's
// opencode profile keeps the same form).
const PREFIXED_MODEL_ADAPTERS = new Set(["pi_local", "opencode_local"]);
const PREFIXED_MODEL_PROVIDER_IDS = new Set(["opencode", "pi"]);

const ADAPTER_NAMES = new Map<string, string>([
  ["claude_local", "Claude"],
  ["codex_local", "Codex"],
  ["grok_local", "Grok"],
  ["gemini_local", "Gemini"],
  ["cursor_local", "Cursor"],
  ["cursor_cloud", "Cursor"],
  ["kimi_local", "Kimi"],
  ["opencode_local", "OpenCode"],
  ["pi_local", "Pi"],
  ["openclaw_gateway", "OpenClaw"],
  ["hermes_gateway", "Hermes gateway"],
  ["hermes_local", "Hermes"],
  ["hermes", "Hermes"],
  ["paperclip_runner", "Paperclip runner"],
  ["process", "Process (no model)"],
  ["http", "HTTP"],
]);

// Clients that have a default provider when none is configured.
const ROUTING_ADAPTERS = new Set(["hermes_local", "hermes", "pi_local", "opencode_local", "paperclip_runner"]);

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function clientName(adapterType: string): string {
  return ADAPTER_NAMES.get(adapterType) ?? adapterType;
}

function providerId(agent: AgentModelGroupInput): string | null {
  const id = text(agent.adapterConfig?.provider)?.toLowerCase() ?? null;
  // The native runner's ACPX backend is a bridge, not an AI provider: the real
  // one is the non-secret `acpxAgent` field (the runtime's default is claude).
  if (id === "acpx") return text(agent.adapterConfig?.acpxAgent)?.toLowerCase() ?? "claude";
  return id;
}

function usesPrefixedModel(agent: AgentModelGroupInput): boolean {
  const id = providerId(agent);
  return PREFIXED_MODEL_ADAPTERS.has(agent.adapterType) || (id !== null && PREFIXED_MODEL_PROVIDER_IDS.has(id));
}

function splitPrefixedModel(agent: AgentModelGroupInput): { provider: string; model: string } | null {
  const model = text(agent.adapterConfig?.model);
  if (!model || !usesPrefixedModel(agent)) return null;
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  const provider = model.slice(0, slash).trim().toLowerCase();
  const rest = model.slice(slash + 1).trim();
  return provider && rest ? { provider, model: rest } : null;
}

export function agentProvider(agent: AgentModelGroupInput): string {
  const client = clientName(agent.adapterType);
  const prefixed = splitPrefixedModel(agent);
  if (prefixed) return PROVIDER_NAMES.get(prefixed.provider) ?? prefixed.provider;
  const id = providerId(agent);
  // The client itself (opencode / pi) is not an AI provider: without a prefixed model it is the default.
  if (id && !PREFIXED_MODEL_PROVIDER_IDS.has(id)) return PROVIDER_NAMES.get(id) ?? `${client} · ${text(agent.adapterConfig?.provider)}`;
  if (ROUTING_ADAPTERS.has(agent.adapterType)) return `${client} (default provider)`;
  return client;
}

export function agentModel(agent: AgentModelGroupInput): string {
  if (agent.adapterType === "process") return "—";
  const prefixed = splitPrefixedModel(agent);
  if (prefixed) return prefixed.model;
  return text(agent.adapterConfig?.model) ?? "default model";
}

export function groupAgentsByModel<A extends AgentModelGroupInput>(agents: A[]): AgentModelGroup<A>[] {
  const providers = new Map<string, Map<string, A[]>>();
  for (const agent of agents) {
    const provider = agentProvider(agent);
    const model = agentModel(agent);
    const models = providers.get(provider) ?? new Map<string, A[]>();
    models.set(model, [...(models.get(model) ?? []), agent]);
    providers.set(provider, models);
  }
  return [...providers.entries()]
    .map(([provider, models]) => ({
      provider,
      count: [...models.values()].reduce((sum, list) => sum + list.length, 0),
      models: [...models.entries()]
        .map(([model, list]) => ({ model, agents: list }))
        .sort((a, b) => b.agents.length - a.agents.length || a.model.localeCompare(b.model)),
    }))
    .sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider));
}
