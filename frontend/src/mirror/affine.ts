// 2D affine transforms as CSS `matrix()` 6-tuples [a, b, c, d, e, f] (column-major: x' = a·x + c·y + e,
// y' = b·x + d·y + f). Used by the mirror to render a clip subtree NESTED inside its clipper: the producer
// streams GLOBAL transforms, so a descendant drawn inside the clip container must be re-expressed RELATIVE to
// the clipper (clipperGlobal⁻¹ · descendantGlobal), else the container's transform would double-apply.

export type Affine = [number, number, number, number, number, number];

export const IDENTITY_AFFINE: Affine = [1, 0, 0, 1, 0, 0];

// NOTE ON INDEXED READS (`m[0]` … `m[5]` rather than `const [a, b, …] = m`): array destructuring runs the ARRAY
// ITERATOR protocol, which allocates an iterator plus one `{value, done}` result object per element whenever the
// caller isn't optimized enough for V8 to escape-analyse them away. In the replay bench that showed up as the single
// biggest allocation site in the whole page — ~75 MB of iterator garbage per 25s combat replay (18.6% of ALL bytes
// allocated), charged to `next` under `affineMul`. Indexed reads produce byte-identical results and allocate
// nothing, so this is unconditional. Keep it that way: do not "tidy" these back into destructuring.

// m · n (apply n first, then m), matching CSS `transform: matrix(m) matrix(n)`.
export function affineMul(m: Affine, n: Affine): Affine {
  const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5];
  const a2 = n[0], b2 = n[1], c2 = n[2], d2 = n[3], e2 = n[4], f2 = n[5];
  return [
    a * a2 + c * b2,
    b * a2 + d * b2,
    a * c2 + c * d2,
    b * c2 + d * d2,
    a * e2 + c * f2 + e,
    b * e2 + d * f2 + f
  ];
}

// `affineMul` writing into a CALLER-OWNED 6-tuple instead of a fresh one, for the hot paths whose product is
// provably TRANSIENT (consumed into a string / a number before the next call — see nodeStyles' placement chain).
// Every input is read into a local BEFORE the first write, so `out` may safely alias `m` and/or `n`
// (`affineMulInto(m, parentInv, m)` is the intended shape). Returns `out` so it reads like `affineMul`.
//
// DANGER: never hand a scratch tuple to anything that RETAINS it (a WalkCtx's parentInv/parentGlobal, a record's
// cached design global, an interactive rect) — those must keep allocating. When in doubt, use `affineMul`.
export function affineMulInto(out: Affine, m: Affine, n: Affine): Affine {
  const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5];
  const a2 = n[0], b2 = n[1], c2 = n[2], d2 = n[3], e2 = n[4], f2 = n[5];
  out[0] = a * a2 + c * b2;
  out[1] = b * a2 + d * b2;
  out[2] = a * c2 + c * d2;
  out[3] = b * c2 + d * d2;
  out[4] = a * e2 + c * f2 + e;
  out[5] = b * e2 + d * f2 + f;
  return out;
}

// Inverse of an affine matrix, or null when singular (degenerate scale — caller falls back to identity).
export function affineInverse(m: Affine): Affine | null {
  const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5];
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) {
    return null;
  }
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)];
}

// A node's placement matrix: its GLOBAL Transform2D [a,b,c,d,tx,ty] composed with a translate to its
// node-local box origin (lr.x, lr.y), so the box can render at (0,0,w,h). Equivalent to the renderer's old
// `matrix(transform) translate(lr.x, lr.y)`.
export function nodeMatrix(
  transform: readonly number[],
  localRect: { x: number; y: number }
): Affine {
  const a = transform[0], b = transform[1], c = transform[2], d = transform[3];
  const tx = transform[4], ty = transform[5];
  return [a, b, c, d, a * localRect.x + c * localRect.y + tx, b * localRect.x + d * localRect.y + ty];
}

// `nodeMatrix` into a caller-owned tuple — same transient-only contract as `affineMulInto`. `out` may alias
// nothing here (the inputs are a readonly wire array + a rect), but every read still precedes every write.
export function nodeMatrixInto(
  out: Affine,
  transform: readonly number[],
  localRect: { x: number; y: number }
): Affine {
  const a = transform[0], b = transform[1], c = transform[2], d = transform[3];
  const tx = transform[4], ty = transform[5];
  out[0] = a;
  out[1] = b;
  out[2] = c;
  out[3] = d;
  out[4] = a * localRect.x + c * localRect.y + tx;
  out[5] = b * localRect.x + d * localRect.y + ty;
  return out;
}

export function affineCss(m: Affine): string {
  return `matrix(${m[0]}, ${m[1]}, ${m[2]}, ${m[3]}, ${m[4]}, ${m[5]})`;
}

// The LINEAR (2×2) part of a CSS transform string the mirror itself wrote — i.e. the part that decides an
// element's RASTERIZATION SCALE (translation doesn't). Understands exactly the function forms nodeStyle emits:
// `matrix(a, b, c, d, e, f)`, `scale(s)` / `scale(sx, sy)` (the atlas fit) and `translate(x, y)`/`translateX/Y`
// (ignored — pure translation). Returns null for an empty string or ANY function it doesn't understand, which
// callers must treat as "assume it changed" — the conservative direction (see queueDeraster's scale gate).
export function cssLinear2x2(css: string | null | undefined): [number, number, number, number] | null {
  if (css == null) {
    return null;
  }
  const text = css.trim();
  if (text === "" || text === "none") {
    return [1, 0, 0, 1];
  }
  let m: Affine = IDENTITY_AFFINE;
  const fn = /([a-zA-Z]+)\(([^)]*)\)/g;
  let seen = 0;
  let match: RegExpExecArray | null;
  while ((match = fn.exec(text)) !== null) {
    seen++;
    const name = match[1].toLowerCase();
    const args = match[2]
      .split(",")
      .map((part) => Number(part.trim().replace(/px$/, "")));
    if (args.some((n) => !Number.isFinite(n))) {
      return null; // a unit/keyword we don't model (deg, %, calc(), …)
    }
    if (name === "matrix" && args.length === 6) {
      m = affineMul(m, args as unknown as Affine);
    } else if (name === "scale" && (args.length === 1 || args.length === 2)) {
      m = affineMul(m, [args[0], 0, 0, args.length === 2 ? args[1] : args[0], 0, 0]);
    } else if (name === "translate" && (args.length === 1 || args.length === 2)) {
      // pure translation — cannot change the linear part
    } else if ((name === "translatex" || name === "translatey") && args.length === 1) {
      // ditto
    } else {
      return null;
    }
  }
  if (seen === 0) {
    return null;
  }
  return [m[0], m[1], m[2], m[3]];
}
