import { DEEPSEEK_BASE_URL, DEEPSEEK_DEFAULT_MODEL } from "@/lib/deepseek-policy";

/** The only script/text LLM preset in the Windows-local application. */
export interface LLMPreset {
  label: string;
  baseUrl: string;
  model: string;
  tipKey?: string;
  apiKey?: string;
}

export const LLM_PRESETS: LLMPreset[] = [
  { label: "DeepSeek", baseUrl: DEEPSEEK_BASE_URL, model: DEEPSEEK_DEFAULT_MODEL, tipKey: "presetDeepseekTip" },
];
