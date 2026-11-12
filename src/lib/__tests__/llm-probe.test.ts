// @vitest-environment node
import { describe, it, expect } from "vitest";
import { probeLLMEndpoint } from "@/lib/llm-probe";
import { listModels } from "@/lib/llm-models";
import { createLLMClient } from "@/lib/llm-error";
import { assertDeepSeekEndpoint, assertDeepSeekConfig } from "@/lib/deepseek-policy";
import { parseScriptResponse } from "@/lib/script-engine/generator";

describe("DeepSeek-only egress security", () => {
  it("normalizes exact verified origins without letting credentials, queries, or SSRF hosts through", () => {
    for (const url of ["https://api.deepseek.com", "https://api.deepseek.com/",
      "https://api.deepseek.com/v1", "https://api.deepseek.com/v1/"]) {
      expect(assertDeepSeekEndpoint(url)).toBe("https://api.deepseek.com");
    }
    for (const url of ["", "http://api.deepseek.com", "https://openrouter.ai/api/v1",
      "http://127.0.0.1:3000", "https://api.deepseek.com.evil.test",
      "https://api.deepseek.com@evil.test", "https://api.deepseek.com/other",
      "https://api.deepseek.com/?target=evil", "https://api.deepseek.com/#secret",
      "https://api.deepseek.com:444"]) {
      expect(() => assertDeepSeekEndpoint(url)).toThrow("DEEPSEEK_ONLY_ENDPOINT");
    }
  });

  it("text V4 Pro is allowed but only Flash may analyze images", () => {
    expect(assertDeepSeekConfig({ baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro",
      visionModel: "deepseek-flash" }).model).toBe("deepseek-v4-pro");
    expect(() => assertDeepSeekConfig({ baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro",
      visionModel: "deepseek-v4-pro" })).toThrow("DEEPSEEK_VISION_REQUIRES_FLASH");
    for (const model of ["gpt-4o", "openai/gpt-4o", "deepseek-v4-flash", "qwen2.5"]) {
      expect(() => assertDeepSeekConfig({ baseUrl: "https://api.deepseek.com", model }))
        .toThrow("DEEPSEEK_ONLY_MODEL");
    }
  });

  it("probe refuses forged provider/model before invoking fetch", async () => {
    let calls = 0;
    const fakeFetch = (async () => { calls++; return new Response("never called"); }) as typeof fetch;
    await expect(probeLLMEndpoint({ baseUrl: "https://openrouter.ai/api/v1", apiKey: "k",
      model: "deepseek-flash", fetchImpl: fakeFetch })).rejects.toThrow("DEEPSEEK_ONLY_ENDPOINT");
    await expect(probeLLMEndpoint({ baseUrl: "https://api.deepseek.com", apiKey: "k",
      model: "gpt-5", fetchImpl: fakeFetch })).rejects.toThrow("DEEPSEEK_ONLY_MODEL");
    await expect(listModels("https://openrouter.ai/api/v1", "k", fakeFetch)).rejects.toThrow("DEEPSEEK_ONLY_ENDPOINT");
    expect(calls).toBe(0);
  });

  it("probe uses DeepSeek and returns success with deterministic mock response", async () => {
    const requests: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(input));
      expect(init?.headers).toMatchObject({ Authorization: "Bearer DS_TEST" });
      const body = JSON.parse(String(init?.body)) as { model: string };
      expect(body.model).toBe("deepseek-flash");
      return new Response(JSON.stringify({ id: "mock", choices: [{ message: { content: "ok" } }] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const out = await probeLLMEndpoint({ baseUrl: "https://api.deepseek.com/v1", apiKey: "DS_TEST",
      model: "deepseek-flash", fetchImpl: fakeFetch });
    expect(out.ok).toBe(true);
    expect(requests).toEqual(["https://api.deepseek.com/chat/completions"]);
  });

  it("model discovery filters third-party or obsolete model IDs", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({
      data: [{ id: "gpt-4o" }, { id: "deepseek-flash" }, { id: "deepseek-v4-pro" },
        { id: "deepseek-v4-flash" }],
    }), { status: 200 })) as typeof fetch;
    expect(await listModels("https://api.deepseek.com", "DS_TEST", fakeFetch))
      .toEqual(["deepseek-flash", "deepseek-v4-pro"]);
  });

  it("product script remains parseable for mocked DeepSeek structured output", () => {
    const mock = JSON.stringify({ scripts: [{
      title: "Review", styleType: "unboxing", totalDuration: 8,
      shots: [{ shotId: 1, type: "product_reveal", duration: 8,
        description: "Open box and inspect product", voiceover: "This sneaker is light and flexible.",
        camera: "close-up", visualSource: "product_image", transition: "direct_concat" }],
    }] });
    const scripts = parseScriptResponse(mock, "unboxing");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].shots).toHaveLength(1);
    expect(scripts[0].shots[0].voiceover).toContain("sneaker");
    expect(createLLMClient({ baseUrl: "https://api.deepseek.com", apiKey: "DS_TEST",
      model: "deepseek-flash" }).baseURL).toBe("https://api.deepseek.com");
  });
});
