import { describe, expect, it } from "vitest";
import {
  catalogBaseModelId,
  catalogFamilyId,
  fillCatalogGaps,
  inferCatalogHints,
  isAuxiliaryModelId,
  isFineTuneModelId,
  pickLookupModelIds,
} from "./model-catalog-hints.js";

describe("catalog id helpers", () => {
  it("unwraps modern and legacy fine-tunes", () => {
    expect(
      catalogBaseModelId("ft:gpt-3.5-turbo-1106:getapper::8MOjMH1E"),
    ).toBe("gpt-3.5-turbo-1106");
    expect(
      catalogBaseModelId("davinci:ft-personal-2023-08-24-16-25-55"),
    ).toBe("davinci");
  });

  it("collapses dated snapshots to the family alias", () => {
    expect(catalogFamilyId("gpt-4o-2024-08-06")).toBe("gpt-4o");
    expect(catalogFamilyId("ft:gpt-4o-mini:org::abc")).toBe("gpt-4o-mini");
  });

  it("flags fine-tunes and auxiliary endpoints", () => {
    expect(isFineTuneModelId("ft:gpt-4o:x::y")).toBe(true);
    expect(isAuxiliaryModelId("text-embedding-3-large")).toBe(true);
    expect(isAuxiliaryModelId("whisper-1")).toBe(true);
    expect(isAuxiliaryModelId("gpt-4o")).toBe(false);
  });
});

describe("inferCatalogHints", () => {
  it("fills well-known chat families and leaves unknown names empty", () => {
    expect(inferCatalogHints("gpt-4o")).toEqual({
      vision: true,
      tools: true,
      contextWindowTokens: 128_000,
    });
    expect(inferCatalogHints("gpt-3.5-turbo")).toMatchObject({
      vision: false,
      tools: true,
    });
    expect(inferCatalogHints("text-embedding-3-small")).toEqual({
      vision: false,
      tools: false,
    });
    expect(inferCatalogHints("some-custom-router")).toEqual({});
  });

  it("inherits fine-tune flags from the base family", () => {
    expect(
      inferCatalogHints("ft:gpt-4o-mini:getapper::xyz"),
    ).toMatchObject({ vision: true, tools: true });
    expect(
      inferCatalogHints("davinci:ft-personal-2023-08-24-16-25-55"),
    ).toEqual({ vision: false, tools: false });
  });
});

describe("fillCatalogGaps / pickLookupModelIds", () => {
  it("does not overwrite a human-set flag", () => {
    const [filled] = fillCatalogGaps([
      { id: "gpt-4o", vision: false, source: "user" },
    ]);
    expect(filled?.vision).toBe(false);
    expect(filled?.tools).toBe(true);
  });

  it("asks the LLM for a short current-chat list", () => {
    const ids = [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4o-2024-08-06",
      "text-embedding-3-large",
      "whisper-1",
      "davinci:ft-personal-2023-08-24-16-25-55",
      "ft:gpt-3.5-turbo-1106:getapper::8MOjMH1E",
      "gpt-3.5-turbo",
    ];
    const picked = pickLookupModelIds({
      modelIds: ids,
      defaultModel: "gpt-4o",
      limit: 20,
    });
    expect(picked.send).toContain("gpt-4o");
    expect(picked.send).toContain("gpt-4o-mini");
    expect(picked.send).not.toContain("whisper-1");
    expect(picked.send).not.toContain(
      "ft:gpt-3.5-turbo-1106:getapper::8MOjMH1E",
    );
    expect(picked.send).not.toContain("gpt-4o-2024-08-06");
    expect(picked.skipped).toBeGreaterThan(0);
  });
});
