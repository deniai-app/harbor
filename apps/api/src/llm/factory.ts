import type { ReviewLlmProvider } from "./types";
import { OpenAiReviewProvider } from "./openai-provider";

export function createLlmProvider(params: {
  provider: string;
  model: string;
  openaiApiKey?: string;
}): ReviewLlmProvider {
  if (params.provider === "openai") {
    if (!params.openaiApiKey) {
      throw new Error("OPENAI_API_KEY is required when LLM_PROVIDER=openai.");
    }

    return new OpenAiReviewProvider(params.openaiApiKey, params.model);
  }

  throw new Error(`Unsupported LLM provider: ${params.provider}`);
}
