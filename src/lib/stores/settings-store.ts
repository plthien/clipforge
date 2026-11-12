import { createPersistentStorage } from "./persistent-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/config";
import { DEFAULT_TTS_PROVIDER, type TTSProvider } from "@/lib/tts-presets";
import {
  DEFAULT_IMAGE_PARAMS,
  DEFAULT_VIDEO_PARAMS,
  type CustomModel,
  type ImageGenParams,
  type VideoGenParams,
} from "@/lib/gen-params";
import { ATLAS_BASE_URL, fillAtlasModelDefaults } from "@/lib/atlas-onekey";
import type { MotionIntensity, MotionRealismTier } from "@/lib/motion-prompt";
import { DEEPSEEK_BASE_URL, DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_VISION_MODEL, isDeepSeekEndpoint, normalizeSavedDeepSeekModel } from "@/lib/deepseek-policy";
import {
  isProductionProfileId,
  productionProfilePatch,
  type ProductionProfileId,
} from "@/lib/production-profiles";

// AI Provider 配置
export interface ProviderSetting {
  enabled: boolean;
  apiKey: string;
  baseUrl?: string;
}

// LLM 配置
export interface LLMSetting {
  provider: string; // 自定义名称
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel?: string; // 视觉分析模型
}

// TTS 配音配置（多平台：OpenAI 兼容 / Atlas / MiniMax / fal.ai）
export interface TTSSetting {
  enabled: boolean;
  /** 平台，缺省 "openai"（旧配置无此字段时按 openai 处理） */
  provider?: TTSProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  speed?: number;
  /** MiniMax 国内端点的 GroupId（可选） */
  groupId?: string;
}

export interface SettingsState {
  // AI 平台配置
  providers: Record<string, ProviderSetting>;
  // LLM 配置
  llm: LLMSetting;
  // TTS 配音配置
  tts: TTSSetting;
  // 默认生图模型
  defaultImageModel: string;
  // 默认生视频模型
  defaultVideoModel: string;
  // 默认分辨率
  defaultResolution: "720p" | "1080p";
  /** Refuse a single paid generation whose estimate exceeds this many USD (0 = no cap) */
  spendCapUsd: number;
  // 默认画面比例
  defaultAspectRatio: "9:16" | "16:9" | "1:1";
  // 用户自定义模型（挂在已有平台上的任意 model id）
  customModels: CustomModel[];
  // 图片生成全局默认参数
  imageParams: ImageGenParams;
  // 视频生成全局默认参数
  videoParams: VideoGenParams;
  // i2v 运镜强度档位（轻/中/强，作用于 motion prompt 的运镜幅度措辞）
  motionIntensity: MotionIntensity;
  // i2v 物理真实感层档位（auto=全层默认 / constraints=仅品类约束 / off=关闭）
  motionRealism: MotionRealismTier;
  // i2v 接缝模式（pin=下一镜关键帧钉尾帧[默认] / tail=用上一镜真实尾帧当首帧续拍 / off=不链）
  chainMode: "pin" | "tail" | "off";
  // 全局画面风格 Look（look-presets.ts 预设 id，"none"=不加；同时注入生图 prompt 与 i2v 光线锚点）
  visualLook: string;
  // UI complexity mode: "simple" keeps only the happy path (beginner default),
  // "pro" reveals the director panel, per-shot camera tools, template workshop etc.
  uiMode: "simple" | "pro";
  // 面向创作目标的当前生产方案（原子更新下方 provider-agnostic 参数）
  activeProductionProfile: ProductionProfileId;
  // 界面语言（首次按系统语言自动判定，可手动切换）
  locale: Locale;
  // 语言来源：auto=跟随系统语言自动判定，user=用户手动选过（不再自动覆盖）
  localeSource: "auto" | "user";

  // Actions
  setLocale: (locale: Locale) => void;
  // 自动判定结果应用（仅在 localeSource==="auto" 时由初始化器调用，不改变 source）
  applyAutoLocale: (locale: Locale) => void;
  setProvider: (name: string, setting: ProviderSetting) => void;
  setLLM: (llm: LLMSetting) => void;
  setTTS: (tts: TTSSetting) => void;
  setDefaultImageModel: (model: string) => void;
  setDefaultVideoModel: (model: string) => void;
  setDefaultResolution: (resolution: "720p" | "1080p") => void;
  setSpendCapUsd: (usd: number) => void;
  setDefaultAspectRatio: (ratio: "9:16" | "16:9" | "1:1") => void;
  addCustomModel: (model: CustomModel) => void;
  removeCustomModel: (id: string) => void;
  setImageParams: (params: ImageGenParams) => void;
  setVideoParams: (params: VideoGenParams) => void;
  setMotionIntensity: (intensity: MotionIntensity) => void;
  setMotionRealism: (tier: MotionRealismTier) => void;
  setChainMode: (mode: "pin" | "tail" | "off") => void;
  setVisualLook: (look: string) => void;
  setUiMode: (mode: "simple" | "pro") => void;
  applyProductionProfile: (profile: ProductionProfileId) => void;
  /** 一个 Atlas Key 一键接入：脚本+看图+生图+生视频+配音全配好（不覆盖用户已选模型/已开的配音） */
  applyAtlasOneKey: (apiKey: string) => void;
}

/** Migrate only the LLM slot. Media/TTS provider credentials remain intact. */
export function normalizeDeepSeekSetting(llm?: Partial<LLMSetting>): LLMSetting {
  // A prior provider's key must NEVER be forwarded to DeepSeek, including Atlas one-key.
  const keepKey = isDeepSeekEndpoint(llm?.baseUrl);
  return {
    provider: "DeepSeek",
    baseUrl: DEEPSEEK_BASE_URL,
    apiKey: keepKey ? (llm?.apiKey ?? "") : "",
    model: keepKey ? normalizeSavedDeepSeekModel(llm?.model) : DEEPSEEK_DEFAULT_MODEL,
    visionModel: DEEPSEEK_VISION_MODEL,
  };
}

export function migrateSettings(state: SettingsState): SettingsState {
  return {
    ...state,
    llm: normalizeDeepSeekSetting(state?.llm),
    activeProductionProfile: isProductionProfileId(state?.activeProductionProfile)
      ? state.activeProductionProfile : "balanced",
  };
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      providers: {
        "atlas-cloud": { enabled: false, apiKey: "" },
        "fal-ai": { enabled: false, apiKey: "" },
        replicate: { enabled: false, apiKey: "" },
        volcengine: { enabled: false, apiKey: "" },
        alibaba: { enabled: false, apiKey: "" },
        siliconflow: { enabled: false, apiKey: "" },
        openai: { enabled: false, apiKey: "" },
      },
      llm: normalizeDeepSeekSetting(),
      tts: {
        enabled: false,
        provider: DEFAULT_TTS_PROVIDER,
        baseUrl: "",
        apiKey: "",
        model: "",
        voice: "",
        speed: 1,
      },
      defaultImageModel: "",
      defaultVideoModel: "",
      defaultResolution: "720p",
      // a per-run ceiling, on by default: an unattended run used to be able to spend
      // whatever the model charged, with no figure shown beforehand (issue #28)
      spendCapUsd: 5,
      defaultAspectRatio: "9:16",
      customModels: [],
      imageParams: DEFAULT_IMAGE_PARAMS,
      videoParams: DEFAULT_VIDEO_PARAMS,
      motionIntensity: "normal",
      motionRealism: "auto",
      chainMode: "pin",
      visualLook: "none",
      uiMode: "simple",
      activeProductionProfile: "balanced",
      locale: DEFAULT_LOCALE,
      localeSource: "auto",

      // 用户手动切换：记为 user，之后不再被自动判定覆盖
      setLocale: (locale) => set({ locale, localeSource: "user" }),
      // 自动判定应用：保持 source=auto，跟随系统语言
      applyAutoLocale: (locale) => set({ locale }),
      setProvider: (name, setting) =>
        set((state) => ({
          providers: { ...state.providers, [name]: setting },
        })),
      setLLM: (llm) => set({ llm: normalizeDeepSeekSetting(llm) }),
      setTTS: (tts) => set({ tts }),
      setDefaultImageModel: (model) => set({ defaultImageModel: model }),
      setDefaultVideoModel: (model) => set({ defaultVideoModel: model }),
      setDefaultResolution: (resolution) => set({ defaultResolution: resolution }),
      setSpendCapUsd: (usd) => set({ spendCapUsd: Number.isFinite(usd) && usd >= 0 ? usd : 0 }),
      setDefaultAspectRatio: (ratio) => set({ defaultAspectRatio: ratio }),
      addCustomModel: (model) =>
        set((state) => ({ customModels: [...state.customModels, model] })),
      removeCustomModel: (id) =>
        set((state) => ({ customModels: state.customModels.filter((m) => m.id !== id) })),
      setImageParams: (params) => set({ imageParams: params }),
      setVideoParams: (params) => set({ videoParams: params }),
      setMotionIntensity: (intensity) => set({ motionIntensity: intensity }),
      setMotionRealism: (tier) => set({ motionRealism: tier }),
      setChainMode: (mode) => set({ chainMode: mode }),
      setVisualLook: (look) => set({ visualLook: look }),
      setUiMode: (mode) => set({ uiMode: mode }),
      applyProductionProfile: (profile) =>
        set((state) => productionProfilePatch(profile, state)),
      // 一个 Atlas Key 一键接入全套：LLM 脚本 + Vision 看图 + 生图 + 生视频 + Atlas 配音
      applyAtlasOneKey: (apiKey) =>
        set((state) => {
          const key = apiKey.trim();
          const def = fillAtlasModelDefaults({
            image: state.defaultImageModel,
            video: state.defaultVideoModel,
          });
          return {
            providers: {
              ...state.providers,
              "atlas-cloud": { ...state.providers["atlas-cloud"], enabled: true, apiKey: key },
            },
            defaultImageModel: def.image,
            defaultVideoModel: def.video,
            // 配音：之前没开过才默认接 Atlas TTS（复用同一个 Key），已配则保持不动
            tts: state.tts.enabled
              ? state.tts
              : { ...state.tts, enabled: true, provider: "atlas", baseUrl: ATLAS_BASE_URL, model: "", voice: "" },
          };
        }),
    }),
    {
      storage: createPersistentStorage<SettingsState>(),
      name: "daihuo-jianshou-settings",
      // v1：清洗历史版本预设写入的失效模型名（旧预设填过不存在的模型 ID，"测试连接"只验 Key
      // 不验模型名所以一直显示正常，直到生成脚本才报 Model Not Exist——issue #12 用户即此场景）。
      // 只在 baseUrl 匹配对应官方端点时改写，避免误伤自建代理上的同名自定义模型。
      // v2：把已停用的 Pollinations 免 Key 地址迁到新端点（见 migrateSettings 注释）。
      // v3：Ollama 的 localhost:11434 改写成 127.0.0.1:11434（Windows 上 ::1 连不通）。
      // v4：补充面向创作目标的生产方案；旧设置迁移到兼顾质量与成本的 balanced。
      // v5：Atlas 一键接入曾把「素材网关」/api/v1 写进 LLM 地址，导致写脚本必 404（issue #24），
      // 迁到 OpenAI 兼容的聊天网关 /v1。
      version: 6,
      migrate: (persisted) => migrateSettings(persisted as SettingsState),
    }
  )
);
