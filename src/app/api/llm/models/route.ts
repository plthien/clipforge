import { NextRequest, NextResponse } from "next/server";
import { errText } from "@/lib/api-error";
import { listModels } from "@/lib/llm-models";
import { assertDeepSeekEndpoint } from "@/lib/deepseek-policy";

/** Expose only models reported by the official DeepSeek API endpoint. */
export async function POST(req: NextRequest) {
  try {
    const { baseUrl, apiKey } = await req.json();
    if (!baseUrl) {
      return NextResponse.json({ ok: false, error: errText(req, "缺少 baseUrl", "Missing baseUrl") }, { status: 400 });
    }
    const endpoint = assertDeepSeekEndpoint(baseUrl);
    const models = await listModels(endpoint, String(apiKey || ""));
    if (models.length === 0) {
      return NextResponse.json({
        ok: false,
        models: [],
        error: errText(
          req,
          "无法读取 DeepSeek 模型列表，请检查 Key、网络及 API 权限",
          "Could not read DeepSeek model list: check the API key, network and model access",
        ),
      });
    }
    return NextResponse.json({ ok: true, models });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      models: [],
      error: error instanceof Error ? error.message : errText(req, "读取失败", "Request failed"),
    }, { status: 400 });
  }
}
