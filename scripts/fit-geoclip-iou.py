#!/usr/bin/env python3
"""Fit a replayed geoclip render onto the game's own render, by maximising mask IoU.

Three free parameters — a UNIFORM image scale and a translation — are searched so that the replayed
frame lands on the ground-truth frame:

    canvas'' = imageScale * canvas' + (tx, ty)

and the result is composed with the `--fit` the render was produced under (the "seed") to give the fit
you should replay with next time. Only the textured ALPHA mask is compared, so `--bg transparent` on the
render is mandatory: with an opaque background every pixel is "covered" and the objective is constant.

    python3 -m venv /tmp/venv && /tmp/venv/bin/pip install numpy pillow      # numpy is not system-wide

USAGE

    # one frame (the historical form — unchanged, still four positionals)
    fit-geoclip-iou.py <render.png> <truth-manifest.json> <frame> '<seed-fit-json>'

    # several frames at once: one candidate fit is scored on ALL of them and the best MEAN IoU wins
    fit-geoclip-iou.py --truth <manifest.json> --seed '<json>' \\
        --render-dir <probe-out-dir> --frames 0,30,45

    # ...and the same run with the last descent scored by REAL renders instead of resamples (defect 4)
    fit-geoclip-iou.py --truth <manifest.json> --seed '<json>' \\
        --render-dir <probe-out-dir> --frames 0,30,45 \\
        --refine-by-rerender --artifact <geoclip bake dir>

`--render-dir` matches what `scripts/probe-geoclip-replay.mjs --frames 0,30,45 --out DIR --bg transparent
--fit '<seed>'` writes, so one probe invocation feeds one multi-frame fit. Stdout is always exactly one
JSON object; everything explanatory goes to stderr under `-v`.

WHY MULTI-FRAME IS THE DEFAULT ADVICE. A single frame's IoU optimum is a fit for THAT POSE. Averaging over
frames spread across the clip is what separates a real placement error from one pose's silhouette. Note
that a truth manifest may cover fewer frames than the clip has; frames past the end of the manifest cannot
be scored.

WHAT THIS REPLACES, AND THE FOUR DEFECTS IT FIXES

The predecessor was a 69-line scratch script. Its answers are not wrong so much as unfalsifiable, for
three separate reasons, all of which produced the same symptom: it reported "zero correction needed",
which reads as "the fit is already right" but only ever meant "no single move I tried helped". Defect 4 is
this tool's own, found by measuring its answers against real renders after 1-3 were fixed: the same
symptom, one level up. Every one of them is a way of mistaking a limit of the SEARCH for a fact about the
FIT, which is what to suspect the next time this thing says zero.

  1. ONE START. It took the single best cell of a coarse lattice and ran one local search from it. The
     lattice is ~10k cells and 9,999 of them were discarded. The IoU surface here is multi-modal — a rig
     can sit one "limb width" off and still find a locally-good overlap — so the best coarse cell is
     regularly in the wrong basin. FIX: keep the top K cells that are NOT lattice-adjacent to an
     already-kept cell (so they are distinct basins rather than one peak sampled K times), search from
     each, and keep the best. `-v` prints the per-start table so the basins are visible.

  2. THE SEED NEVER ENTERED THE SEARCH. The seed was used only to compose the printed fit; the search
     itself ran a fixed lattice about the render as-is. With a badly-off seed the +-60px window is simply
     centred on the wrong place and the answer is a local artefact of where the window happened to fall.
     FIX: an extra start derived from the two masks' own bounding boxes (scale = extent ratio, translation
     = centre difference), which needs no window at all and lands in the right basin regardless of seed.
     Both grids are also anchored so that "no correction" (scale 1.0, shift 0) is always ON the lattice.

  3. SUB-PIXEL REFINEMENT WAS INERT. `warp()` sampled with `rint` on a mask MAX-POOLED by 4, so for a pure
     translation nothing changed until tx/4 crossed a half-integer — an effective quantum of 4 full-res
     px, and 2 px at the very best. The refinement's last four step halvings (3 -> 1.5 -> 0.75 -> 0.375 ->
     0.1875 px) were all below that quantum: they could not change the score, they only burned the move
     budget. The advertised "0.15 px" precision did not exist. FIX: the refine stage runs at `--refine-ds`
     (default 1 = full resolution), where a sub-pixel step does move the score. Sweeping tx in 0.375 px
     steps across the merchant's frame-45 optimum, holding everything else fixed, shows both halves:

         tx        +2.625    +3.000    +3.375    +3.750
         ds=1     0.99030   0.99299   0.99351   0.99055     <- a peak, resolvable to a third of a pixel
         ds=4     0.98146   0.98261   0.98261   0.98270     <- two cells IDENTICAL, and the best is wrong

     The pooling was not only imprecise, it was BIASED: max-pooling dilates both masks by up to 4 px,
     which inflates IoU (it forgives up to a 4 px edge error for free) and flattens the surface into a
     wide shallow plateau. Measured on the merchant rig, frame 45: at zero correction the pooled objective
     says 0.9592 and the full-res one says 0.9570; at the correct fit the pooled one says 0.9807 while
     full-res says 0.9845. The pooled objective understates how much there was to win.

  ...and one plain bug: the scale sweep was `arange(0.94, 1.16, 0.01)`, whose stop is EXCLUSIVE, so the
  top of the advertised range was never tried. Both grid ends are inclusive here.

  4. THE REFINE SCORES A RESAMPLE, NOT A RENDER — so its fixed point is not the objective's. Fixing defect
     3 made the refine stage's steps sub-pixel, but every candidate it scores is still `warp()`: the
     ALREADY-RASTERISED render on disk, gathered through `rint`. A resample cannot REPRESENT a sub-pixel
     move, only re-quantise one, so near the optimum the prediction goes FLAT and the search stops
     somewhere the real rasteriser does not. Walking the merchant's seed frames 0/30/45 from this tool's
     own fixed point to the answer `--refine-by-rerender` finds, scoring every step both ways:

         fraction of the correction    0     1/8     1/4     1/2     3/4       1
         resample PREDICTS        0.99325 0.99325 0.99325 0.99325 0.99338 0.99341
         render MEASURES          0.99325 0.99391 0.99447 0.99573 0.99681 0.99776
         predictor error           0.0000 +0.0007 +0.0012 +0.0025 +0.0034 +0.0043

     Over the first HALF of the correction the prediction is not merely wrong, it is CONSTANT to five
     decimal places while the render climbs 0.0025 — so the refinement sees a strict tie, `top > best` is
     false, and it halves the step instead of taking the move. It then reports a +0.0002 gain for a fit
     that is worth +0.0045. byrdonis is worse: the resample predicts the answer as EXACTLY its starting
     0.9928, a dead-flat nothing, where the render measures 0.9994. (An earlier probe at a nearby
     placement reported the error at +0.0031 with the sign inverted; same defect, sampled elsewhere.)

     No setting of `--min-shift-step` reaches this. The refinement is BLIND to the moves that are left,
     not merely too coarse for them. FIX: the opt-in `--refine-by-rerender` mode below, which scores
     candidates by rendering them.

WHICH STAGE USES WHICH DOWNSAMPLE, AND WHY.  Coarse sweep at `--coarse-ds` (default 4), refine at
`--refine-ds` (default 1). The coarse sweep only has to identify basins, and pooling is what makes ~10k
cells affordable; the refine stage has to resolve sub-pixel placement, which pooling makes impossible.
Measured per score on this box, merchant 1004x1418: ds=4 0.14 ms, ds=2 0.56 ms, ds=1 6.2 ms. Set
`--refine-ds 2` to trade precision for ~10x speed.

The warp is separable — a uniform scale plus a translation means the sampled column index depends only on
the column — so it is done with two 1-D index vectors and one gather, rather than the predecessor's full
2-D `mgrid` arithmetic. It is arithmetically identical (same `rint` of the same value; verified to agree
to 4 dp with the old formulation on both rigs) and 86-148x faster at ds=4 as measured on the two, which
is what pays for K starts at full resolution: a whole multi-start run costs less than the old single one.

`--REFINE-BY-RERENDER`: THE ONLY WAY TO GET A TRUE ZERO

Same pattern search, same objective, the same truth masks — but each candidate is a REAL re-render through
`scripts/probe-geoclip-replay.mjs` rather than a resample of the one render already on disk. The coarse
lattice and the multi-start still do the basin-finding in process, unchanged: they are ~10k cheap evals and
they only have to find the right hill. Only the last descent, the part defect 4 makes blind, is re-rendered.

    fit-geoclip-iou.py --truth <manifest.json> --seed '<seed-fit-json>' \\
        --render-dir <render made with that seed> --frames 0,30,45 \\
        --refine-by-rerender --artifact <geoclip bake dir>

WHAT THE THREE KINDS OF ZERO MEAN. This distinction is the whole reason the mode exists:

    the predecessor's zero    "no move I TRIED helps"
    the resampling refine     "no move I can REPRESENT helps"
    --refine-by-rerender      "no move helps"

Only the third is a statement about the fit. Re-rendering at the returned `fit` and refitting is necessary
but NOT sufficient: a re-fit that comes back through `warp()` re-derives the same blind fixed point and
reports the same reassuring zero, which is exactly what happened for six iterations on both rigs here.

`--canvas` defaults to the truth manifest's own canvas, the only size at which the masks are comparable.
Renders are issued with `--bg transparent`, which is mandatory for the same reason it is mandatory for the
seed render: with an opaque background every pixel is covered and the objective is constant. (The
diff/RMSE comparisons that probe-geoclip-replay is normally used for must NOT use it — those want the real
composited colour; this fit wants nothing but alpha.) Every render is checked for its PNGs and a clean GL
census BEFORE it is scored and then deleted, because probe-geoclip-replay binds ONE fixed port and a second
run on it dies of `EADDRINUSE` inside `node:events` — a driver that does not check would score the previous
candidate's leftovers, or a blank, and never notice. A fresh free port is taken per render (`--probe-port`
pins a base instead) and a failed render is retried on another port rather than scored as a zero.

THE DESCENT SCALES ABOUT THE MASK CENTROID, not the canvas origin — see `Rerenderer` for why that is
load-bearing rather than tidy (origin-pivot coordinate descent stalls at 0.9960 where 0.9978 is reachable,
because a scale step there is mostly a translation and the six moves stop being independent). Nothing about
the reported `imageScale`/`tx`/`ty` changes; only the directions the search steps in.

Cost, measured on this box: merchant 95 renders / 2m18s, byrdonis 97 / 1m39s, at ~1.2-1.4 s per 3-frame
render. Most of that is the last few step halvings, which is where the answer is: stopping at
`--rerender-min-step 0.125` costs 39 renders and gets 0.9973 instead of 0.9978. Results, starting from this
tool's own fixed points and its own seed frames:

                 seed frames             held-out frames
    merchant     0.9932 -> 0.9978        0.9942 -> 0.9987   (5,12,20,38,52,60)
    byrdonis     0.9928 -> 0.9994        0.9926 -> 0.9994   (45,90,180,225,295)

The held-out numbers are the point: the correction is a placement, not an overfit to three poses. Re-run
seeded at either answer and the correction comes back imageScale 1.0, tx 0, ty 0, gain 0.0000 — and this
time that zero has been asked of the rasteriser.

READING THE OUTPUT

  `iou`/`recall`/`precision` are at the REFINE resolution, so they are NOT comparable to the old script's
  numbers; `iouCoarse` is the same fit scored on the pooled masks, which is. `iouIdentity` and `gain` say
  what the correction actually bought, in the objective's own units.

  Without `--refine-by-rerender`, `gain` is a PREDICTION made through a nearest-neighbour resample of an
  already-rasterised mask, not a measurement of a real render — and by defect 4 it is a prediction that is
  wrong by +0.0031 IoU and wrong in SIGN near the optimum, so a zero here means only "zero REPRESENTABLE
  correction". With `--refine-by-rerender`, `gain` is a MEASUREMENT: `iou` is the real render's score at the
  reported `fit`, `iouPredicted` is what the resample would have claimed for that same fit, and
  `predictorError` is the difference — kept in the output so the blindness stays visible rather than being
  something the next reader has to rediscover.

  `--dead-band` reports zero correction when `gain` falls below a threshold, for callers that only want to
  hear about corrections worth acting on; it defaults to 0, i.e. off, because suppressing a real correction
  by default is the predecessor's failure mode with better manners.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image

# Alpha above this counts as covered. Kept from the predecessor so the two tools' masks are the same
# masks: 8/255 is below any real edge coverage but above PNG quantisation noise in fully-clear regions.
ALPHA_FLOOR = 8


# ---------------------------------------------------------------------------------------------------
# masks
# ---------------------------------------------------------------------------------------------------


def _pool(mask: np.ndarray, ds: int) -> np.ndarray:
    """Max-pool by `ds`. Dilates by up to ds-1 px, which is exactly why only the coarse stage uses it."""
    if ds == 1:
        return mask
    h, w = mask.shape
    h -= h % ds
    w -= w % ds
    return mask[:h, :w].reshape(h // ds, ds, w // ds, ds).max(axis=(1, 3))


class Level:
    """One (frame, downsample) pair, preprocessed into something scoreable in a few milliseconds."""

    def __init__(self, truth: np.ndarray, render: np.ndarray, ds: int) -> None:
        self.ds = ds
        self.full_shape = truth.shape
        self.T = _pool(truth, ds)
        self.R = _pool(render, ds)
        self.h, self.w = self.T.shape
        self.tsum = int(np.count_nonzero(self.T))
        self.cols = np.arange(self.w, dtype=np.float64)
        self.rows = np.arange(self.h, dtype=np.float64)

    def warp(self, fs: float, tx: float, ty: float) -> np.ndarray:
        """The render resampled by canvas'' = fs*canvas' + t. `tx`/`ty` are FULL-res px at every ds."""
        ix = np.rint((self.cols - tx / self.ds) / fs).astype(np.intp)
        iy = np.rint((self.rows - ty / self.ds) / fs).astype(np.intp)
        okx = (ix >= 0) & (ix < self.w)
        oky = (iy >= 0) & (iy < self.h)
        out = self.R[np.ix_(np.clip(iy, 0, self.h - 1), np.clip(ix, 0, self.w - 1))]
        return out & oky[:, None] & okx[None, :]

    def stats(self, fs: float, tx: float, ty: float) -> tuple[float, float, float]:
        warped = self.warp(fs, tx, ty)
        inter = int(np.count_nonzero(warped & self.T))
        wsum = int(np.count_nonzero(warped))
        union = wsum + self.tsum - inter
        return (
            inter / union if union else 0.0,
            inter / self.tsum if self.tsum else 0.0,
            inter / wsum if wsum else 0.0,
        )

    def iou(self, fs: float, tx: float, ty: float) -> float:
        return self.stats(fs, tx, ty)[0]

    def stats_of(self, mask: np.ndarray) -> tuple[float, float, float]:
        """(iou, recall, precision) for a FULL-RES mask that came from somewhere else — a real re-render.

        The counterpart of `stats()` with the warp taken out: nothing is resampled, because the candidate
        placement was baked into the render itself rather than approximated on top of one.
        """
        if mask.shape != self.full_shape:
            raise SystemExit(
                f"fit-geoclip-iou: a re-render came back {mask.shape[1]}x{mask.shape[0]}, but the truth "
                f"canvas is {self.full_shape[1]}x{self.full_shape[0]}"
            )
        pooled = _pool(mask, self.ds)
        inter = int(np.count_nonzero(pooled & self.T))
        rsum = int(np.count_nonzero(pooled))
        union = rsum + self.tsum - inter
        return (
            inter / union if union else 0.0,
            inter / self.tsum if self.tsum else 0.0,
            inter / rsum if rsum else 0.0,
        )

    def centroid(self) -> tuple[float, float]:
        """The truth mask's centre of mass in FULL-res px — the pivot the re-render descent scales about."""
        rows, cols = np.nonzero(self.T)
        if not rows.size:
            return (self.w * self.ds / 2, self.h * self.ds / 2)
        return (float(cols.mean()) * self.ds, float(rows.mean()) * self.ds)

    def bbox(self) -> tuple[tuple[float, float, float, float], tuple[float, float, float, float]]:
        """(truth, render) bounding boxes in FULL-res px, as (cx, cy, width, height)."""
        def box(mask: np.ndarray) -> tuple[float, float, float, float]:
            cols = np.flatnonzero(mask.any(axis=0))
            rows = np.flatnonzero(mask.any(axis=1))
            if not cols.size or not rows.size:
                return (0.0, 0.0, 0.0, 0.0)
            x0, x1 = float(cols[0]), float(cols[-1] + 1)
            y0, y1 = float(rows[0]), float(rows[-1] + 1)
            return ((x0 + x1) / 2 * self.ds, (y0 + y1) / 2 * self.ds,
                    (x1 - x0) * self.ds, (y1 - y0) * self.ds)
        return box(self.T), box(self.R)


def load_frame(render_png: str, manifest: dict, index: int) -> tuple[np.ndarray, np.ndarray, int, int]:
    """-> (truth mask, render mask, canvasWidth, canvasHeight), both on the full canvas."""
    frames = manifest["frames"]
    if index >= len(frames):
        raise SystemExit(
            f"fit-geoclip-iou: frame {index} is outside the truth manifest, which covers 0-{len(frames) - 1}. "
            "Ground truth is often shorter than the clip; pick frames inside it."
        )
    frame = frames[index]
    width, height = frame["canvasWidth"], frame["canvasHeight"]

    # Truth frames are stored CROPPED to their own bounding box plus the offset that puts them back, so
    # they have to be composited onto the full canvas before anything is comparable.
    tile = Image.open(frame["path"]).convert("RGBA")
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    canvas.alpha_composite(tile, (frame["offsetX"], frame["offsetY"]))
    truth = np.array(canvas)[:, :, 3] > ALPHA_FLOOR

    render = np.array(Image.open(render_png).convert("RGBA"))[:, :, 3] > ALPHA_FLOOR
    if render.shape != truth.shape:
        raise SystemExit(
            f"fit-geoclip-iou: {render_png} is {render.shape[1]}x{render.shape[0]} but frame {index}'s canvas "
            f"is {width}x{height}. Re-render with --canvas {width}x{height}."
        )
    return truth, render, width, height


# ---------------------------------------------------------------------------------------------------
# search
# ---------------------------------------------------------------------------------------------------


def anchored_grid(lo: float, hi: float, step: float, anchor: float) -> np.ndarray:
    """Inclusive lattice over [lo, hi] whose points are anchor + k*step, so `anchor` is always ON it.

    Inclusive because `np.arange(0.94, 1.16, 0.01)` silently dropped 1.16 — the top of the range the old
    script advertised was never evaluated.
    """
    k_lo = int(np.ceil((lo - anchor) / step - 1e-9))
    k_hi = int(np.floor((hi - anchor) / step + 1e-9))
    if k_hi < k_lo:
        return np.array([anchor])
    return anchor + step * np.arange(k_lo, k_hi + 1)


def compose_fit(seed: dict, fs: float, tx: float, ty: float) -> dict:
    """The correction (fs, tx, ty) folded into the seed fit, at the precision this tool reports.

    Rounding here rather than only on the way out is deliberate for `--refine-by-rerender`: the render that
    produced the reported `iou` is then the render of the reported `fit`, digit for digit, so the number is
    a measurement of the thing printed next to it and not of a fit 1e-6 away from it.
    """
    return {
        "scaleX": round(fs * seed["scaleX"], 5),
        "scaleY": round(fs * seed["scaleY"], 5),
        "offsetX": round(fs * seed["offsetX"] + tx, 3),
        "offsetY": round(fs * seed["offsetY"] + ty, 3),
    }


def mean_iou(levels: list[Level], fs: float, tx: float, ty: float) -> float:
    if len(levels) == 1:
        return levels[0].iou(fs, tx, ty)
    return float(np.mean([lv.iou(fs, tx, ty) for lv in levels]))


def coarse_starts(levels: list[Level], scales, shifts_x, shifts_y, k: int, verbose):
    """Score the whole lattice, then keep the best k cells that are not lattice-neighbours of a keeper.

    Adjacency suppression is the point: without it the "top k" are the same peak sampled k times and the
    multi-start degenerates back into the single start it was meant to replace.
    """
    scores = np.empty((len(scales), len(shifts_x), len(shifts_y)), dtype=np.float64)
    for i, fs in enumerate(scales):
        for j, tx in enumerate(shifts_x):
            for kk, ty in enumerate(shifts_y):
                scores[i, j, kk] = mean_iou(levels, float(fs), float(tx), float(ty))

    order = np.argsort(scores, axis=None)[::-1]
    kept: list[tuple[int, int, int]] = []
    starts: list[tuple[float, float, float, float]] = []
    for flat in order:
        i, j, kk = (int(v) for v in np.unravel_index(int(flat), scores.shape))
        if any(abs(i - a) <= 1 and abs(j - b) <= 1 and abs(kk - c) <= 1 for a, b, c in kept):
            continue
        kept.append((i, j, kk))
        starts.append((float(scores[i, j, kk]), float(scales[i]), float(shifts_x[j]), float(shifts_y[kk])))
        if len(starts) >= k:
            break

    verbose(f"  coarse lattice: {scores.size} cells, best {scores.max():.4f}, "
            f"{len(starts)} non-adjacent start(s) kept")
    return starts, int(scores.size)


def moment_start(level: Level) -> tuple[float, float, float] | None:
    """A start read straight off the two masks' bounding boxes — no search window, so no window to miss.

    This is the fix for "the seed never entered the search": the old lattice was centred on the render as
    it happened to be, so a seed that was far out put the true answer outside the +-60px window entirely.
    """
    (tcx, tcy, tw, th), (rcx, rcy, rw, rh) = level.bbox()
    if tw <= 0 or th <= 0 or rw <= 0 or rh <= 0:
        return None
    fs = 0.5 * (tw / rw + th / rh)
    return fs, tcx - fs * rcx, tcy - fs * rcy


def pattern_search(score, start, step_f, step_t, min_step_t, max_evals, verbose):
    """Steepest-of-six pattern search, halving the step when no neighbour improves.

    `score(fs, tx, ty) -> float` is the whole objective. In the default mode it resamples the render on
    disk; under `--refine-by-rerender` it renders the candidate for real. The search is identical either
    way, which is the point: only the thing being asked changes.

    Steepest rather than the predecessor's first-improvement: taking the first neighbour that helps makes
    the path depend on the order the six moves happen to be listed in, which on a ridge walks along the
    ridge instead of up it.
    """
    fs, tx, ty = start
    best = score(fs, tx, ty)
    evals = 1
    while step_t >= min_step_t and evals < max_evals:
        moves = [(fs + step_f, tx, ty), (fs - step_f, tx, ty),
                 (fs, tx + step_t, ty), (fs, tx - step_t, ty),
                 (fs, tx, ty + step_t), (fs, tx, ty - step_t)]
        scored = [(score(*m), m) for m in moves]
        evals += len(moves)
        top, move = max(scored, key=lambda pair: pair[0])
        if top > best:
            best, (fs, tx, ty) = top, move
        else:
            step_f /= 2
            step_t /= 2
    if evals >= max_evals:
        verbose(f"    (start hit the {max_evals}-eval budget before converging)")
    return best, fs, tx, ty, evals


# ---------------------------------------------------------------------------------------------------
# scoring by re-render
# ---------------------------------------------------------------------------------------------------


def free_port() -> int:
    """An ephemeral port the OS has just confirmed is free, released again for the probe to claim."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class Rerenderer:
    """Scores a candidate placement by RENDERING it, so the objective is the rasteriser and not a resample.

    One instance owns one temp tree, one memo (candidates repeat: a pattern search that steps +tx then
    halves re-visits the point it came from) and the eval counter that the run reports.

    IT ALSO MOVES THE PIVOT, and that is not cosmetic. In the (imageScale, tx, ty) the rest of this tool
    speaks, scale is taken about the CANVAS ORIGIN, so a scale step is mostly a translation: 0.005 of scale
    slides the merchant's anchor 2.97 px across and 6.42 px down, which near the optimum is a large move in
    a direction the two translation axes also cover. The six pattern-search moves are then not independent,
    the useful direction is a diagonal none of them point along, and the descent stalls on the valley wall —
    measured, 0.9960 where 0.9978 was reachable. Scaling about the truth mask's own CENTROID instead leaves
    the rig where it is and only changes its size, so the three axes are near-orthogonal and the same search
    walks to 0.9978. Only the search's internal coordinates change: `to_pivot`/`from_pivot` convert, and
    everything reported is still origin-pivot (imageScale, tx, ty).
    """

    NAME_PATTERN = "frame-%04d.png"

    def __init__(self, args, levels: list[Level], frames: list[int], seed: dict,
                 canvas: list[int], verbose) -> None:
        self.replay = args.replay or os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "probe-geoclip-replay.mjs")
        if not os.path.isfile(self.replay):
            raise SystemExit(f"fit-geoclip-iou: no probe-geoclip-replay.mjs at {self.replay} (--replay)")
        if not os.path.isdir(args.artifact):
            raise SystemExit(f"fit-geoclip-iou: --artifact {args.artifact} is not a directory")
        self.node = args.node
        self.artifact = os.path.abspath(args.artifact)
        self.levels = levels
        self.frames = frames
        self.seed = seed
        self.width, self.height = canvas
        self.verbose = verbose
        self.retries = max(0, args.probe_retries)
        self.port_base = args.probe_port
        self.port_seq = 0
        self.memo: dict[tuple, tuple] = {}
        self.evals = 0
        self.renders = 0
        self.root = tempfile.mkdtemp(prefix="fit-geoclip-rerender-")
        pivots = np.array([lv.centroid() for lv in levels], dtype=np.float64)
        self.px, self.py = (float(pivots[:, 0].mean()), float(pivots[:, 1].mean()))

    def close(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def to_pivot(self, fs: float, tx: float, ty: float) -> tuple[float, float, float]:
        """(imageScale, tx, ty) as this tool reports it -> the centroid-pivot coordinates it searches in."""
        return (fs, tx - (1 - fs) * self.px, ty - (1 - fs) * self.py)

    def from_pivot(self, fs: float, ux: float, uy: float) -> tuple[float, float, float]:
        return (fs, ux + (1 - fs) * self.px, uy + (1 - fs) * self.py)

    def next_port(self) -> int:
        if self.port_base:
            # Walk a window rather than reusing one port: a just-closed listener can sit in TIME_WAIT, and
            # the probe's bind is not retried on its side — it throws out of `node:events`.
            port = self.port_base + self.port_seq % 64
            self.port_seq += 1
            return port
        return free_port()

    def render_once(self, fit: dict, out_dir: str) -> tuple[list[str] | None, str]:
        """-> (frame paths, '') on a render that is safe to score, or (None, why-not)."""
        shutil.rmtree(out_dir, ignore_errors=True)
        command = [
            self.node, self.replay,
            "--artifact", self.artifact,
            "--canvas", f"{self.width}x{self.height}",
            "--frames", ",".join(str(i) for i in self.frames),
            # Alpha is the entire signal; an opaque clear would make every pixel "covered".
            "--bg", "transparent",
            "--name-pattern", self.NAME_PATTERN,
            "--fit", json.dumps(fit),
            "--out", out_dir,
            "--port", str(self.next_port()),
        ]
        try:
            proc = subprocess.run(command, capture_output=True, text=True)
        except OSError as error:
            return None, f"could not launch {self.node}: {error}"

        # Everything below is here because a render that FAILED must not be scored as a bad placement. The
        # probe owns a fixed default port and dies on a collision; scoring its leftovers (or a blank frame)
        # would report a confident IoU for a picture nothing drew.
        paths = [os.path.join(out_dir, self.NAME_PATTERN % i) for i in self.frames]
        missing = [p for p in paths if not (os.path.isfile(p) and os.path.getsize(p) > 0)]
        if proc.returncode != 0:
            return None, f"exit {proc.returncode}"
        if missing:
            return None, f"{len(missing)} frame PNG(s) were not written ({os.path.basename(missing[0])} ...)"

        payload = None
        for line in (proc.stdout or "").splitlines():
            if line.startswith("GEOCLIP_REPLAY_RESULT "):
                try:
                    payload = json.loads(line[len("GEOCLIP_REPLAY_RESULT "):])
                except json.JSONDecodeError:
                    payload = None
        if payload is None:
            return None, "no GEOCLIP_REPLAY_RESULT line"
        if payload.get("glErrors"):
            return None, f"{payload['glErrors']} GL error(s)"
        if len(payload.get("frames", [])) != len(self.frames):
            return None, f"rendered {len(payload.get('frames', []))} frame(s), wanted {len(self.frames)}"
        return paths, ""

    def render(self, fit: dict, out_dir: str) -> list[str]:
        why = ""
        for attempt in range(self.retries + 1):
            paths, why = self.render_once(fit, out_dir)
            self.renders += 1
            if paths:
                return paths
            left = self.retries - attempt
            self.verbose(f"      render failed ({why})" +
                         (f"; retrying on a fresh port, {left} attempt(s) left" if left else ""))
        raise SystemExit(
            f"fit-geoclip-iou: a candidate render failed after {self.retries + 1} attempt(s): {why}\n"
            f"  fit {json.dumps(fit)}\n"
            f"  {' '.join([self.node, self.replay, '--artifact', self.artifact])} ...\n"
            "  Refusing to score a render that did not happen."
        )

    def measure(self, fit: dict) -> tuple[float, list[tuple[float, float, float]]]:
        """Render this fit for real and score it. Memoised on the fit, which is what the render depends on."""
        key = (fit["scaleX"], fit["scaleY"], fit["offsetX"], fit["offsetY"])
        hit = self.memo.get(key)
        if hit is not None:
            return hit
        out_dir = os.path.join(self.root, f"eval-{self.evals:04d}")
        paths = self.render(fit, out_dir)
        self.evals += 1
        per = []
        for path, level in zip(paths, self.levels):
            mask = np.array(Image.open(path).convert("RGBA"))[:, :, 3] > ALPHA_FLOOR
            per.append(level.stats_of(mask))
        # ~1.4 MB per merchant frame: keeping every candidate is how a previous sweep left 900 MB behind.
        shutil.rmtree(out_dir, ignore_errors=True)
        found = (float(np.mean([p[0] for p in per])), per)
        self.memo[key] = found
        return found

    def score(self, fs: float, ux: float, uy: float) -> float:
        """The pattern search's objective, in centroid-pivot coordinates."""
        return self.measure(compose_fit(self.seed, *self.from_pivot(fs, ux, uy)))[0]

    def stats_at(self, fs: float, tx: float, ty: float) -> list[tuple[float, float, float]]:
        """Per-frame (iou, recall, precision) at a reported (imageScale, tx, ty). A memo hit after a search."""
        return self.measure(compose_fit(self.seed, fs, tx, ty))[1]


# ---------------------------------------------------------------------------------------------------
# cli
# ---------------------------------------------------------------------------------------------------


def parse_frames(spec: str) -> list[int]:
    out: list[int] = []
    for chunk in str(spec).split(","):
        piece = chunk.strip()
        if not piece:
            continue
        if "-" in piece[1:]:
            lo, hi = piece.split("-", 1)
            out.extend(range(int(lo), int(hi) + 1))
        else:
            out.append(int(piece))
    return sorted(set(out))


def expand_pattern(pattern: str, index: int) -> str:
    seen = False

    def sub(match):
        nonlocal seen
        seen = True
        zero, width = match.group(1), match.group(2)
        text = str(index)
        return text.rjust(int(width), "0") if zero and width else text

    out = re.sub(r"%(0?)(\d*)d", sub, pattern)
    if not seen:
        raise SystemExit(f"fit-geoclip-iou: pattern '{pattern}' has no %d / %0Nd placeholder")
    return out


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fit-geoclip-iou.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("positional", nargs="*", metavar="RENDER TRUTH FRAME SEED",
                        help="the historical four-positional form: render.png truth.json frame seed-json")
    parser.add_argument("--truth", help="ground-truth manifest json (positional 2)")
    parser.add_argument("--seed", help="the --fit the render was produced with, as json (positional 4)")
    parser.add_argument("--render", action="append", default=[], metavar="IDX:PATH",
                        help="one frame to score, repeatable; e.g. --render 45:/shots/frame-0045.png")
    parser.add_argument("--render-dir", metavar="DIR",
                        help="a probe-geoclip-replay --out directory, used with --frames")
    parser.add_argument("--render-pattern", default="frame-%04d.png",
                        help="filename pattern inside --render-dir (default frame-%%04d.png)")
    parser.add_argument("--frames", help="frame indices for --render-dir, e.g. '0,30,45' or '0-8'")

    parser.add_argument("--starts", type=int, default=6, metavar="K",
                        help="how many non-adjacent coarse basins to refine (default 6)")
    parser.add_argument("--no-moment-start", action="store_true",
                        help="drop the extra bounding-box start (defect 2's fix)")
    parser.add_argument("--scale-min", type=float, default=0.94)
    parser.add_argument("--scale-max", type=float, default=1.16)
    parser.add_argument("--scale-step", type=float, default=0.01)
    parser.add_argument("--wide", action="store_true", help="shorthand for --scale-min 0.90 --scale-max 1.20")
    parser.add_argument("--shift", type=float, default=60.0, metavar="PX",
                        help="translation half-window in full-res px (default 60)")
    parser.add_argument("--shift-step", type=float, default=6.0, metavar="PX",
                        help="coarse translation lattice step (default 6)")
    parser.add_argument("--coarse-ds", type=int, default=4, help="downsample for the sweep (default 4)")
    parser.add_argument("--refine-ds", type=int, default=1, help="downsample for the refine (default 1)")
    parser.add_argument("--min-shift-step", type=float, default=None, metavar="PX",
                        help="stop refining below this step (default 0.25*refine-ds; see the header on why "
                             "a step under ~0.5*ds only bites because the scale term breaks lockstep)")
    parser.add_argument("--max-evals", type=int, default=600, help="objective evals per start (default 600)")
    parser.add_argument("--dead-band", type=float, default=0.0, metavar="IOU",
                        help="report zero correction when the IoU gain is below this (default 0 = off)")

    rr = parser.add_argument_group(
        "refine by re-render",
        "Score the last descent with real renders instead of resamples (defect 4). Opt-in: without "
        "--refine-by-rerender none of these are read and the run is byte-identical to before.")
    rr.add_argument("--refine-by-rerender", action="store_true",
                    help="re-render every refine candidate through probe-geoclip-replay.mjs")
    rr.add_argument("--artifact", metavar="DIR", help="the geoclip bake to replay (required by the mode)")
    rr.add_argument("--canvas", metavar="WxH",
                    help="render size; defaults to the truth manifest's own canvas, which is the only "
                         "size the masks can be compared at")
    rr.add_argument("--replay", metavar="PATH",
                    help="path to probe-geoclip-replay.mjs (default: next to this script)")
    rr.add_argument("--node", default="node", metavar="EXE", help="node executable (default 'node')")
    rr.add_argument("--probe-port", type=int, default=0, metavar="N",
                    help="base http port for the probe; 0 (default) takes a fresh free port per render. "
                         "The probe binds ONE port and a collision throws out of node:events, so two "
                         "fitters must not share a base.")
    rr.add_argument("--probe-retries", type=int, default=2, metavar="N",
                    help="re-render attempts, on a new port each time, before failing the run (default 2)")
    rr.add_argument("--rerender-step", type=float, default=None, metavar="PX",
                    help="initial translation step for the re-render descent (default 0.5*--shift-step)")
    rr.add_argument("--rerender-min-step", type=float, default=0.01, metavar="PX",
                    help="stop the re-render descent below this step (default 0.01). It reads as an absurd "
                         "translation floor and is not one: the scale step halves in LOCKSTEP with it, and "
                         "0.005 of scale is 3.5 px at the merchant's silhouette edge, so this is really a "
                         "~0.01 px DISPLACEMENT floor on both axes. Raise it to trade the last ~0.0005 IoU "
                         "for ~35 renders.")
    rr.add_argument("--rerender-max-evals", type=int, default=300, metavar="N",
                    help="render budget for the re-render descent (default 300)")
    parser.add_argument("-v", "--verbose", action="store_true", help="per-start basin table on stderr")
    parser.add_argument("--indent", type=int, default=1, help="json indent (default 1)")
    return parser


def resolve_inputs(args, parser) -> tuple[str, str, list[tuple[int, str]]]:
    """-> (truth manifest path, seed json text, [(frame index, render png), ...])."""
    truth, seed = args.truth, args.seed
    pairs: list[tuple[int, str]] = []

    if args.positional:
        if len(args.positional) != 4:
            parser.error("the positional form takes exactly 4 arguments: RENDER TRUTH FRAME SEED")
        render, truth_pos, frame, seed_pos = args.positional
        truth = truth or truth_pos
        seed = seed or seed_pos
        pairs.append((int(frame), render))

    for spec in args.render:
        if ":" not in spec:
            parser.error(f"--render wants IDX:PATH, got '{spec}'")
        idx, path = spec.split(":", 1)
        pairs.append((int(idx), path))

    if args.render_dir:
        if not args.frames:
            parser.error("--render-dir needs --frames")
        for idx in parse_frames(args.frames):
            pairs.append((idx, os.path.join(args.render_dir, expand_pattern(args.render_pattern, idx))))

    if not pairs:
        parser.error("no frames given: use the positional form, --render IDX:PATH, or --render-dir + --frames")
    if not truth:
        parser.error("--truth (or positional 2) is required")
    if not seed:
        parser.error("--seed (or positional 4) is required")

    seen = {}
    for idx, path in pairs:
        seen[idx] = path
    return truth, seed, sorted(seen.items())


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    truth_path, seed_text, pairs = resolve_inputs(args, parser)

    def verbose(message: str) -> None:
        if args.verbose:
            print(message, file=sys.stderr)

    try:
        seed = json.loads(seed_text)
    except json.JSONDecodeError as error:
        parser.error(f"--seed is not json: {error}")
    for key in ("scaleX", "scaleY", "offsetX", "offsetY"):
        if key not in seed:
            parser.error(f"--seed has no '{key}'")

    if args.wide:
        args.scale_min, args.scale_max = min(args.scale_min, 0.90), max(args.scale_max, 1.20)
    if args.coarse_ds < 1 or args.refine_ds < 1:
        parser.error("--coarse-ds / --refine-ds must be >= 1")
    min_step_t = args.min_shift_step if args.min_shift_step is not None else 0.25 * args.refine_ds

    render_canvas = None
    if args.canvas:
        shape = re.fullmatch(r"(\d+)x(\d+)", args.canvas.strip())
        if not shape:
            parser.error("--canvas must be WxH")
        render_canvas = [int(shape.group(1)), int(shape.group(2))]
    if args.refine_by_rerender and not args.artifact:
        parser.error("--refine-by-rerender needs --artifact (the bake it should re-render)")
    if args.artifact and not args.refine_by_rerender:
        parser.error("--artifact is only read by --refine-by-rerender; add it or drop --artifact")

    manifest = json.load(open(truth_path))
    coarse: list[Level] = []
    refine: list[Level] = []
    canvas = None
    for index, render_png in pairs:
        truth_mask, render_mask, width, height = load_frame(render_png, manifest, index)
        if canvas is not None and canvas != [width, height]:
            raise SystemExit("fit-geoclip-iou: the supplied frames do not share one canvas size")
        canvas = [width, height]
        coarse.append(Level(truth_mask, render_mask, args.coarse_ds))
        refine.append(Level(truth_mask, render_mask, args.refine_ds) if args.refine_ds != args.coarse_ds
                      else coarse[-1])
    verbose(f"fit-geoclip-iou: {len(pairs)} frame(s) {[i for i, _ in pairs]} on {canvas[0]}x{canvas[1]}, "
            f"coarse ds={args.coarse_ds} refine ds={args.refine_ds}")
    if render_canvas and render_canvas != canvas:
        raise SystemExit(
            f"fit-geoclip-iou: --canvas {render_canvas[0]}x{render_canvas[1]} disagrees with the truth "
            f"manifest's {canvas[0]}x{canvas[1]}; the masks would not be comparable."
        )

    rerender = Rerenderer(args, refine, [i for i, _ in pairs], seed, canvas, verbose) \
        if args.refine_by_rerender else None
    try:
        return search_and_report(args, verbose, seed, pairs, canvas, coarse, refine,
                                 min_step_t, rerender)
    finally:
        if rerender:
            rerender.close()


def search_and_report(args, verbose, seed, pairs, canvas, coarse, refine, min_step_t, rerender) -> int:
    scales = anchored_grid(args.scale_min, args.scale_max, args.scale_step, 1.0)
    shifts_x = anchored_grid(-args.shift, args.shift, args.shift_step, 0.0)
    shifts_y = anchored_grid(-args.shift, args.shift, args.shift_step, 0.0)
    starts, cells = coarse_starts(coarse, scales, shifts_x, shifts_y, max(1, args.starts), verbose)

    seeds: list[tuple[str, tuple[float, float, float]]] = [
        (f"coarse#{n} ({s:.4f})", (fs, tx, ty)) for n, (s, fs, tx, ty) in enumerate(starts)
    ]
    if not args.no_moment_start:
        guess = moment_start(coarse[0])
        if guess:
            seeds.append(("bbox-moment", guess))

    resample = lambda fs, tx, ty: mean_iou(refine, fs, tx, ty)  # noqa: E731 — one line, one meaning

    verbose("    start                     ->    imageScale       tx       ty       IoU   evals")
    best = None
    evals_total = cells
    for label, start in seeds:
        score, fs, tx, ty, evals = pattern_search(
            resample, start, 0.005, args.shift_step / 2, min_step_t, args.max_evals, verbose)
        evals_total += evals
        verbose(f"    {label:<24s} ->  {fs:12.6f} {tx:+8.3f} {ty:+8.3f}   {score:.4f}   {evals:5d}")
        if best is None or score > best[0]:
            best = (score, fs, tx, ty)

    score, fs, tx, ty = best
    predicted = None
    if rerender:
        # Everything above was basin-finding: which hill, to within a pixel or so. The last descent is the
        # part defect 4 makes blind, so it is walked with real renders from wherever the resample stopped.
        step = args.rerender_step if args.rerender_step is not None else args.shift_step / 2
        verbose(f"    re-render descent from the winner, step {step:g} -> {args.rerender_min_step:g} px, "
                f"{len(pairs)} frame(s) per eval, pivot ({rerender.px:.1f}, {rerender.py:.1f})")
        score, fs, ux, uy, renders = pattern_search(
            rerender.score, rerender.to_pivot(fs, tx, ty), 0.005, step, args.rerender_min_step,
            args.rerender_max_evals, verbose)
        fs, tx, ty = rerender.from_pivot(fs, ux, uy)
        predicted = mean_iou(refine, fs, tx, ty)
        verbose(f"    re-render                ->  {fs:12.6f} {tx:+8.3f} {ty:+8.3f}   {score:.4f}   "
                f"{renders:5d}   (the resample would have said {predicted:.4f})")

    identity = mean_iou(refine, 1.0, 0.0, 0.0)
    gain = score - identity
    dead_banded = False
    if args.dead_band > 0 and gain < args.dead_band:
        dead_banded = True
        score, fs, tx, ty = identity, 1.0, 0.0, 0.0
        gain, predicted = 0.0, None

    per_frame = []
    measured = rerender.stats_at(fs, tx, ty) if (rerender and not dead_banded) else None
    for position, ((index, _), level) in enumerate(zip(pairs, refine)):
        iou, recall, precision = measured[position] if measured else level.stats(fs, tx, ty)
        per_frame.append({"index": index, "iou": round(iou, 4),
                          "recall": round(recall, 4), "precision": round(precision, 4)})
    recall = float(np.mean([f["recall"] for f in per_frame]))
    precision = float(np.mean([f["precision"] for f in per_frame]))

    result = {
        "iou": round(float(score), 4),
        "recall": round(recall, 4),
        "precision": round(precision, 4),
        "imageScale": round(float(fs), 5),
        "tx": round(float(tx), 2),
        "ty": round(float(ty), 2),
        "canvas": canvas,
        "fit": compose_fit(seed, fs, tx, ty),
        "frames": [i for i, _ in pairs],
        "perFrame": per_frame,
        "iouIdentity": round(float(identity), 4),
        "gain": round(float(gain), 4),
        "iouCoarse": round(float(mean_iou(coarse, fs, tx, ty)), 4),
        "coarseDs": args.coarse_ds,
        "refineDs": args.refine_ds,
        "starts": len(seeds),
        "evals": evals_total,
    }
    if rerender:
        # `iou` and `gain` are now MEASUREMENTS of a real render at exactly the `fit` printed above them.
        result["refinedBy"] = "rerender"
        result["rerenders"] = rerender.renders
        result["rerenderEvals"] = rerender.evals
        if predicted is not None:
            result["iouPredicted"] = round(float(predicted), 4)
            result["predictorError"] = round(float(score - predicted), 4)
    if dead_banded:
        result["deadBand"] = args.dead_band
        result["deadBandApplied"] = True
    print(json.dumps(result, indent=args.indent))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
