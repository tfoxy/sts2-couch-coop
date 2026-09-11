import { afterEach, expect, it, vi } from "vitest";
import { createCanvasStage } from "@godot-scene-web/canvas";
import { mountHtmlScene, renderSceneToHtmlModel, unmountHtmlScene } from "@godot-scene-web/html";
import { createHtmlEffectsHost } from "@godot-scene-web/html/runtime";
import { deriveSceneGraph } from "@godot-scene-web/scene-graph";
import { resolveGodotSceneTree } from "@godot-scene-web/layout";
import { parseGodotTextScene } from "@godot-scene-web/tscn-parser";

// GPU pixels are stubbed; public model, DOM mount, host lifecycle and canvas stage are real.
const bindings = vi.hoisted(() => ({ create: vi.fn(), dispose: vi.fn() }));
vi.mock("../../../../../godot-scene-web/packages/html/src/particles/runtime", () => ({
  createParticleRuntime(stage: HTMLElement) {
    bindings.create();
    const canvases = new Map<Element, HTMLCanvasElement>();
    return {
      reconcile() {
        for (const node of stage.querySelectorAll("[data-godot-particle-runtime]")) {
          if (canvases.has(node)) continue;
          const canvas = document.createElement("canvas");
          canvas.dataset.mixedEffect = "true";
          node.append(canvas);
          canvases.set(node, canvas);
        }
      },
      dispose() {
        bindings.dispose();
        for (const canvas of canvases.values()) canvas.remove();
        canvases.clear();
      }
    };
  }
}));
afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); });

it("composes independently sized and ordered DOM/canvas parts with one effect owner", () => {
  const lower = document.createElement("div");
  const canvas = document.createElement("canvas");
  const upper = document.createElement("div");
  document.body.append(lower, canvas, upper);
  const model = renderSceneToHtmlModel(resolveGodotSceneTree(deriveSceneGraph(parseGodotTextScene(`
[gd_scene format=3]
[node name="Root" type="Control"]
offset_right = 200
offset_bottom = 100
[node name="Caption" type="Label" parent="."]
text = "DOM caption"
`))));
  const dom = mountHtmlScene(lower, model, { enableParticles: true, externalRuntimes: true });
  mountHtmlScene(upper, model);
  const particle = document.createElement("div");
  particle.setAttribute("data-godot-particle-runtime", "{}");
  dom.append(particle);
  expect(bindings.create).not.toHaveBeenCalled();
  const effects = createHtmlEffectsHost(dom, { enableParticles: true });
  effects.reconcile();
  effects.reconcile();
  expect(bindings.create).toHaveBeenCalledOnce();
  expect(lower.querySelectorAll("[data-mixed-effect]")).toHaveLength(1);
  expect(upper.querySelectorAll("[data-mixed-effect]")).toHaveLength(0);
  const viewport = vi.fn();
  const gl = { drawingBufferWidth: 0, drawingBufferHeight: 0, viewport } as unknown as WebGL2RenderingContext;
  vi.spyOn(canvas, "getContext").mockReturnValue(gl);
  const stage = createCanvasStage({ canvas, designWidth: 200, designHeight: 100 });
  expect(stage).not.toBeNull();
  stage!.setStageSize(400, 200);
  stage!.applyViewport();
  expect(viewport).toHaveBeenLastCalledWith(0, 0, 400, 200);
  expect(stage!.projection().designWidth).toBe(200);
  expect(Array.from(document.body.children)).toEqual([lower, canvas, upper]);
  expect(upper.textContent).toContain("DOM caption");
  effects.dispose();
  effects.dispose();
  unmountHtmlScene(lower);
  expect(bindings.dispose).toHaveBeenCalledOnce();
  expect(canvas.isConnected).toBe(true);
  expect(upper.textContent).toContain("DOM caption");
  stage!.setStageSize(600, 300);
  expect(stage!.projection().framebufferWidth).toBe(600);
  stage!.dispose();
  canvas.remove();
  unmountHtmlScene(upper);
  expect(lower.childElementCount + upper.childElementCount).toBe(0);
});
