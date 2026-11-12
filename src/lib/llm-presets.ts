/**
 * One-click LLM presets shown in Settings.
 *
 * Extracted from the settings page so the endpoints are unit-testable: a preset that ships a dead
 * endpoint silently bricks the whole app for anyone who clicks it (issue #19 — Pollinations retired
 * its keyless text API, and every new install that picked that preset failed with a bare 402).
 *
 * `tipKey` is an i18n message key resolved at render time; `apiKey` pre-fills a placeholder only for
 * endpoints that genuinely ignore the key (local Ollama). Never pre-fill a placeholder for an endpoint
 * that requires a real key — it disguises "not configured" as "configured".
 */
export interface LLMPreset {
  label: string;
  baseUrl: string;
  model: string;
  /** i18n key for the short tip shown next to the label (empty = no tip) */
  tipKey?: string;
  /** placeholder key for keyless endpoints only */
  apiKey?: string;
}

import { DEEPSEEK_BASE_URL, DEEPSEEK_DEFAULT_MODEL } from "@/lib/deepseek-policy";

export const LLM_PRESETS: LLMPreset[] = [
  { label: "DeepSeek", baseUrl: DEEPSEEK_BASE_URL, model: DEEPSEEK_DEFAULT_MODEL, tipKey: "presetDeepseekTip" },
];
