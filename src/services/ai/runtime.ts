import {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResult,
  ProviderConfigMap,
  ProviderId,
  TokenUsage,
} from '../../types/model';
import { getModel } from '../../data/models';
import type { LLMProvider, ProviderFactory } from './provider';
import {
  createAnthropicProvider,
  createGeminiProvider,
  createOpenAIProvider,
} from './providers';

/* -------------------------------------------------------------------------- */
/*  Provider registry + AIService                                             */
/* -------------------------------------------------------------------------- */

export class ProviderRegistry {
  private providers = new Map<ProviderId, LLMProvider>();

  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: ProviderId): LLMProvider | undefined {
    return this.providers.get(id);
  }

  has(id: ProviderId): boolean {
    return this.providers.has(id);
  }
  remove(id: ProviderId): void {
    this.providers.delete(id);
  }

  list(): ProviderId[] {
    return Array.from(this.providers.keys());
  }
}

export const providerRegistry = new ProviderRegistry();

/** Configure only providers that have explicit credentials; there is no mock fallback. */
export function configureProviders(configs: ProviderConfigMap): void {
  const factories: Partial<Record<ProviderId, ProviderFactory>> = {
    openai: createOpenAIProvider,
    anthropic: createAnthropicProvider,
    google: createGeminiProvider,
  };

  (Object.keys(factories) as ProviderId[]).forEach((id) => {
    const config = configs[id];
    const factory = factories[id];
    if (!factory || !config?.apiKey?.trim()) {
      if (providerRegistry.has(id)) providerRegistry.remove(id);
      return;
    }
    providerRegistry.register(factory({ config }));
  });
}

/** True when a live provider is active for the given model. */
export function isLiveModel(modelId: string): boolean {
  const model = getModel(modelId);
  const providerId = model?.provider ?? 'openai';
  return providerRegistry.get(providerId)?.live ?? false;
}

export interface AIServiceOptions {
  /** Reserved for backwards compatibility; real providers own their timeouts. */
  latencyMs?: number;
}

export class AIService {
  constructor(private registry: ProviderRegistry = providerRegistry) {}

  /** Register real providers from a `settings.apiKeys` map. */
  configure(configs: ProviderConfigMap): void {
    configureProviders(configs);
  }

  resolveProvider(modelId: string): LLMProvider {
    const model = getModel(modelId);
    const providerId = model?.provider ?? 'openai';
    const provider = this.registry.get(providerId);
    if (!provider) {
      throw new Error(`No provider registered for "${providerId}"`);
    }
    return provider;
  }

  async chat(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
    return this.resolveProvider(req.model).complete(req);
  }

  stream(req: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk> {
    return this.resolveProvider(req.model).stream(req);
  }

  /** Deterministic local hashing embedding for offline indexing (not an LLM response). */
  async embed(text: string, dims = 64): Promise<number[]> {
    const vec = new Array<number>(dims).fill(0);
    const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      let h = 0;
      for (let i = 0; i < token.length; i += 1) {
        h = (h * 31 + token.charCodeAt(i)) >>> 0;
      }
      vec[h % dims] += 1;
    }
    const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
    return vec.map((v) => v / norm);
  }

  estimateCostUsd(modelId: string, usage: TokenUsage): number {
    const model = getModel(modelId);
    if (!model) return 0;
    return (
      (usage.promptTokens / 1_000_000) * model.inputPricePerMTokens +
      (usage.completionTokens / 1_000_000) * model.outputPricePerMTokens
    );
  }
}

export const aiService = new AIService();
