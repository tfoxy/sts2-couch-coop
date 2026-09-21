import { describe, expect, it, vi } from "vitest";
import { normalizeParticleSpecConfig } from "@godot-scene-web/html/runtime";

import {
  canvasBlendFromGodot,
  createEffectPassMapper,
  type EffectPassTextures,
} from "@/mirror/canvas/effectPassMapper";
import type { MirrorNode, MirrorShaderParam } from "@/mirror/sceneTree";

const handle = { texture: {} as WebGLTexture, width: 32, height: 16 };

function param(overrides: Partial<MirrorShaderParam>): MirrorShaderParam {
  return {
    name: "amount",
    kind: "number",
    number: 0.25,
    bool: null,
    string: null,
    color: null,
    vector2: null,
    resourcePath: null,
    vector3: null,
    vector4: null,
    rect2: null,
    transform2d: null,
    numberArray: null,
    ...overrides,
  };
}

function node(overrides: Partial<MirrorNode> = {}): MirrorNode {
  return {
    id: "fx",
    shaderId: "res://shaders/fx.gdshader",
    materialRef: null,
    shaderParams: [param({})],
    textureUrl: "/res/images/base.png",
    fillColor: null,
    modulate: { r: 1, g: 1, b: 1, a: 1 },
    selfModulate: { r: 1, g: 1, b: 1, a: 1 },
    textureStretchMode: null,
    textureFlipH: false,
    textureFlipV: false,
    particleSpec: null,
    particleEmitting: false,
    particleRestartEpoch: 0,
    ...overrides,
  } as MirrorNode;
}

function textures(resolve: EffectPassTextures["resolve"] = () => ({ status: "ready", texture: handle, identity: "test" })): EffectPassTextures {
  return { resolve, resolveSolid: () => ({ status: "ready", texture: handle, identity: "solid" }), resolveLut: () => ({ status: "ready", texture: handle, identity: "lut" }) };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("effectPassMapper", () => {
  it("maps the synthesized material's numeric uniforms and sampler resource into borrowed stage handles", async () => {
    const urls: string[] = [];
    const resolve = vi.fn((url: string) => { urls.push(url); return { status: "ready" as const, texture: handle, identity: url }; });
    const mapper = createEffectPassMapper({
      textures: textures(resolve),
      loadShaderSource: async () => "shader_type canvas_item; uniform float amount; uniform sampler2D mask; void fragment() { COLOR = texture(TEXTURE, UV) * amount; }",
    });
    const effect = node({ shaderParams: [param({}), param({ name: "mask", kind: "resource", number: null, resourcePath: "res://images/mask.png" })] });
    expect(mapper.map(effect)).toMatchObject({ status: "pending", reason: "shader-source" });
    await settle();
    const ready = mapper.map(effect);
    expect(ready).toMatchObject({ status: "ready", kind: "shader", pass: { texture: handle, uniforms: { amount: 0.25 }, samplers: { mask: handle } } });
    expect(urls).toEqual(expect.arrayContaining(["/res/images/base.png", "/res/images/mask.png"]));
  });

  it("marks a SCREEN_TEXTURE shader for painter-position execution", async () => {
    const mapper = createEffectPassMapper({
      textures: textures(),
      loadShaderSource: async () => "shader_type canvas_item; uniform sampler2D screen_tex : hint_screen_texture; void fragment() { COLOR = texture(screen_tex, SCREEN_UV); }",
    });
    expect(mapper.map(node())).toMatchObject({ status: "pending" });
    await settle();
    expect(mapper.map(node())).toMatchObject({ status: "ready", kind: "shader", screenDependent: true });
  });

  it("matches TextureRect contain/cover UV fitting and refuses atlas-page sampling", async () => {
    const wide = { texture: {} as WebGLTexture, width: 200, height: 100 };
    const mapper = createEffectPassMapper({
      textures: textures(() => ({ status: "ready", texture: wide, identity: "wide" })),
      loadShaderSource: async () => "shader_type canvas_item; void fragment() { COLOR = texture(TEXTURE, UV); }",
    });
    const contain = node({ textureStretchMode: 5 });
    mapper.map(contain, { width: 100, height: 100 });
    await settle();
    expect(mapper.map(contain, { width: 100, height: 100 })).toMatchObject({ status: "ready", pass: { uvFit: [1, 0.5] } });
    const cover = node({ textureStretchMode: 6 });
    expect(mapper.map(cover, { width: 100, height: 100 })).toMatchObject({ status: "ready", pass: { uvFit: [2, 1] } });
    expect(mapper.map(node({ textureRegion: { x: 0, y: 0, width: 10, height: 10 } }))).toMatchObject({ status: "unsupported", message: expect.stringContaining("Atlas-region") });
  });

  it("keeps all particle material derivations and borrows sprite, mask, and LUT textures", () => {
    const resolve = vi.fn((url: string) => ({ status: "ready" as const, texture: handle, identity: url }));
    const resolveLut = vi.fn((_stops: unknown, _interpolation: number) => ({ status: "ready" as const, texture: handle, identity: "lut" }));
    const mapper = createEffectPassMapper({ textures: { ...textures(resolve), resolveLut } });
    const effect = node({
      shaderId: null,
      shaderParams: null,
      particleSpec: normalizeParticleSpecConfig({
        kind: "GPUParticles2D",
        textureUrl: "/res/images/particle.png",
        maskUrl: "/res/images/mask.png",
        colorLut: [{ offset: 0, color: [1, 0, 0, 1] }, { offset: 1, color: [0, 1, 0, 1] }],
        colorLutInterpolation: 1,
        blendMode: 1,
      }),
    });
    expect(mapper.map(effect)).toMatchObject({
      status: "ready",
      kind: "particles",
      blend: 1,
      origin: [0, 0],
      pass: {
        config: expect.not.objectContaining({ originX: expect.anything(), originY: expect.anything(), textureUrl: expect.anything(), maskUrl: expect.anything() }),
        spriteTexture: handle,
        maskTexture: handle,
        lutTexture: handle,
      },
    });
    expect(resolve).toHaveBeenCalledWith("/res/images/particle.png");
    expect(resolve).toHaveBeenCalledWith("/res/images/mask.png");
    expect(resolveLut).toHaveBeenCalledWith(effect.particleSpec!.colorLut, 1);
  });

  it("does not fabricate a texture: unresolved resources remain pending and resolver refusals are settled", async () => {
    const pendingMapper = createEffectPassMapper({
      textures: textures(() => ({ status: "pending" })),
      loadShaderSource: async () => "shader_type canvas_item; void fragment() { COLOR = texture(TEXTURE, UV); }",
    });
    expect(pendingMapper.map(node())).toMatchObject({ status: "pending", reason: "shader-source" });
    await settle();
    expect(pendingMapper.map(node())).toMatchObject({ status: "pending", reason: "texture", sourceUrl: "/res/images/base.png" });

    const refusedMapper = createEffectPassMapper({
      textures: textures(),
      loadShaderSource: async () => undefined,
    });
    refusedMapper.map(node());
    await settle();
    expect(refusedMapper.map(node())).toMatchObject({ status: "unsupported", message: expect.stringContaining("unavailable") });
  });

  it("versions every shader material input and particle spec identity deterministically", async () => {
    const mapper = createEffectPassMapper({
      textures: textures(),
      loadShaderSource: async () => "shader_type canvas_item; uniform float amount; void fragment() { COLOR = texture(TEXTURE, UV) * amount; }",
    });
    const first = node();
    mapper.map(first);
    await settle();
    const a = mapper.map(first);
    const b = mapper.map(node({ shaderParams: [param({ number: 0.5 })] }));
    expect(a).toMatchObject({ status: "ready" });
    expect(b).toMatchObject({ status: "ready" });
    expect((a as { resourceVersion: string }).resourceVersion).not.toBe((b as { resourceVersion: string }).resourceVersion);
    const particleA = mapper.map(node({ shaderId: null, shaderParams: null, particleSpec: normalizeParticleSpecConfig({ kind: "GPUParticles2D", amount: 1, blendMode: 0 }) }));
    const particleB = mapper.map(node({ shaderId: null, shaderParams: null, particleSpec: normalizeParticleSpecConfig({ kind: "GPUParticles2D", amount: 2, blendMode: 0 }) }));
    expect((particleA as { resourceVersion: string }).resourceVersion).not.toBe((particleB as { resourceVersion: string }).resourceVersion);
  });

  it("combines self-modulate and advances a version when a same-URL stage handle is replaced", async () => {
    let textureIdentity = "page-v1";
    const mapper = createEffectPassMapper({
      textures: textures(() => ({ status: "ready", texture: handle, identity: textureIdentity })),
      loadShaderSource: async () => "shader_type canvas_item; void fragment() { COLOR = texture(TEXTURE, UV); }",
    });
    const effect = node({ modulate: { r: 0.5, g: 0.25, b: 1, a: 0.8, html: "" }, selfModulate: { r: 0.4, g: 1, b: 0.5, a: 0.5, html: "" } });
    mapper.map(effect);
    await settle();
    const first = mapper.map(effect);
    expect(first).toMatchObject({ status: "ready", kind: "shader" });
    textureIdentity = "page-v2";
    const replacement = mapper.map(effect);
    expect(replacement).toMatchObject({ status: "ready", kind: "shader" });
    if (first?.status !== "ready" || first.kind !== "shader" || replacement?.status !== "ready" || replacement.kind !== "shader") throw new Error("expected ready shader passes");
    expect(first.pass.modulate).toEqual([0.2, 0.25, 0.5, 0.4]);
    expect(replacement.resourceVersion).not.toBe(first.resourceVersion);
  });

  it("uses the stage's four exact blend modes and touches no DOM API", async () => {
    expect(canvasBlendFromGodot("mix")).toBe(0);
    expect(canvasBlendFromGodot("premul_alpha")).toBe(0);
    expect(canvasBlendFromGodot("add")).toBe(1);
    expect(canvasBlendFromGodot("sub")).toBe(2);
    expect(canvasBlendFromGodot("mul")).toBe(3);
    const create = vi.spyOn(document, "createElement");
    const mapper = createEffectPassMapper({
      textures: textures(),
      loadShaderSource: async () => "shader_type canvas_item; void fragment() { COLOR = texture(TEXTURE, UV); }",
    });
    mapper.map(node());
    await settle();
    mapper.map(node());
    expect(create).not.toHaveBeenCalled();
  });
});
