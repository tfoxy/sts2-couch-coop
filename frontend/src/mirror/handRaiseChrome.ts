import { affineMul, type Affine } from "@/mirror/affine";
import type { AtlasSprite } from "@/mirror/atlasSprite";
import type { CanvasHandRaiseChrome } from "@/mirror/renderer/contracts";

export const HAND_RAISE_BOX = { width: 109, height: 109, right: 145, bottom: 7 } as const;
export const HAND_RAISE_INTERIOR_SCALE = 0.875;
export const HAND_RAISE_INTERIOR_TOP = "#2F4A56";
export const HAND_RAISE_INTERIOR_BOTTOM = "#2C4450";
export const HAND_RAISE_GLYPH_COLOR = "#63BDEB";

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawCard(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number): void {
  ctx.save();
  ctx.translate(x + 14, y + 20);
  ctx.rotate((angle * Math.PI) / 180);
  roundedRect(ctx, -14, -20, 28, 40, 4);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Raster the Vue control's authored layers into the canvas backend's one dynamic texture. */
export function paintHandRaiseChrome(
  target: HTMLCanvasElement,
  image: CanvasImageSource,
  sprite: AtlasSprite,
  on: boolean
): void {
  const width = Math.max(1, Math.round(sprite.region.width));
  const height = Math.max(1, Math.round(sprite.region.height));
  target.width = width;
  target.height = height;
  const ctx = target.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(
    image,
    sprite.region.x,
    sprite.region.y,
    sprite.region.width,
    sprite.region.height,
    0,
    0,
    width,
    height
  );

  const inner = document.createElement("canvas");
  inner.width = width;
  inner.height = height;
  const inside = inner.getContext("2d");
  if (inside) {
    const iw = width * HAND_RAISE_INTERIOR_SCALE;
    const ih = height * HAND_RAISE_INTERIOR_SCALE;
    const ix = (width - iw) / 2;
    const iy = (height - ih) / 2;
    inside.drawImage(
      image,
      sprite.region.x,
      sprite.region.y,
      sprite.region.width,
      sprite.region.height,
      ix,
      iy,
      iw,
      ih
    );
    inside.globalCompositeOperation = "source-in";
    const gradient = inside.createLinearGradient(0, iy, 0, iy + ih);
    gradient.addColorStop(0, HAND_RAISE_INTERIOR_TOP);
    gradient.addColorStop(1, HAND_RAISE_INTERIOR_BOTTOM);
    inside.fillStyle = gradient;
    inside.fillRect(ix, iy, iw, ih);
    ctx.drawImage(inner, 0, 0);
  }

  const sx = width / 166;
  const sy = height / 121;
  ctx.save();
  ctx.scale(sx, sy);
  ctx.strokeStyle = HAND_RAISE_GLYPH_COLOR;
  ctx.fillStyle = HAND_RAISE_INTERIOR_BOTTOM;
  ctx.lineWidth = 4.6;
  ctx.lineJoin = "round";
  drawCard(ctx, 47, 62, -22);
  drawCard(ctx, 91, 62, 22);
  drawCard(ctx, 69, 58, 0);
  ctx.beginPath();
  ctx.lineWidth = 6.6;
  ctx.lineCap = "round";
  const points = on ? [[62, 20], [83, 40], [104, 20]] : [[62, 40], [83, 20], [104, 40]];
  ctx.moveTo(points[0][0], points[0][1]);
  ctx.lineTo(points[1][0], points[1][1]);
  ctx.lineTo(points[2][0], points[2][1]);
  ctx.stroke();
  ctx.restore();
}

export function handRaiseChromeMatrix(inputGlobal: Affine, designWidth: number, chrome: CanvasHandRaiseChrome): Affine {
  const scale = chrome.scale;
  const x = designWidth - chrome.right - chrome.width + (chrome.width * (1 - scale)) / 2;
  const y = 1080 - chrome.bottom - chrome.height + (chrome.height * (1 - scale)) / 2;
  return affineMul(inputGlobal, [scale, 0, 0, scale, x, y]);
}
