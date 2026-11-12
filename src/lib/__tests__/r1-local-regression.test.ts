// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = (relative: string) => readFileSync(join(root, relative), "utf8");

describe("R1 Windows local and product-pipeline regression", () => {
  it("keeps the entire product-to-export route chain and its database", () => {
    for (const path of ["src/app/products/page.tsx", "src/app/project/new/page.tsx",
      "src/app/api/llm/script/route.ts", "src/app/project/[id]/assets/page.tsx",
      "src/app/project/[id]/video/page.tsx", "src/app/project/[id]/export/page.tsx",
      "src/lib/video-composer/composer.ts", "src/lib/db/schema.ts", "electron/main.js",
      "LICENSE", "NOTICE"]) {
      expect(existsSync(join(root, path)), path).toBe(true);
    }
  });

  it("no longer serves topic/trend routes but preserves the data schema", () => {
    for (const path of ["src/app/api/topic/script/route.ts", "src/app/api/trends/route.ts",
      "src/app/project/topic/page.tsx"]) {
      expect(existsSync(join(root, path)), path).toBe(false);
    }
    const landing = source("src/app/start/page.tsx");
    expect(landing).not.toContain("/api/trends");
    expect(landing).not.toContain("/api/topic/script");
    expect(landing).toContain("/api/llm/script");
    expect(landing).toContain("/api/ingest/product");
    expect(source("src/lib/db/schema.ts")).toContain("contentType");
  });

  it("no provider selection or Atlas one-key LLM onboarding in Settings", () => {
    const settings = source("src/app/settings/page.tsx");
    expect(settings).toContain('value="https://api.deepseek.com"');
    expect(settings).toContain('value="deepseek-flash"');
    expect(settings).toContain('value="deepseek-v4-pro"');
    expect(settings).not.toContain("applyAtlasOneKey");
    expect(settings).not.toContain("LLM_PRESETS.map");
    const nav = source("src/components/app-shell.tsx");
    expect(nav).toContain('href: "/products"');
    expect(nav).toContain('href: "/projects"');
    expect(nav).toContain('href: "/start"');
  });

  it("desktop and dev bind loopback; no removed distribution entrypoints", () => {
    const scripts = JSON.parse(source("package.json")) as { scripts: Record<string, string> };
    expect(scripts.scripts.dev).toContain("127.0.0.1");
    expect(scripts.scripts.start).toContain("127.0.0.1");
    expect(source("electron/main.js")).toContain('HOSTNAME: "127.0.0.1"');
    for (const path of ["Dockerfile", ".github/workflows/docker-publish.yml",
      "bin/clipforge.mjs", "mcp/clipforge-mcp.mjs",
      "skills.sh.json", "integrations/infinite-canvas/dist/clipforge.js"]) {
      expect(existsSync(join(root, path)), path).toBe(false);
    }
  });
});
