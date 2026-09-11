// Static particles need a representative frame, but one-shot bursts must not
// become permanent decorations. This is the DOM runtime's phase policy in a
// DOM-free form for the strict canvas owner.

export interface StaticParticleSpec {
  readonly lifetime?: number | null;
  readonly explosiveness?: number | null;
  readonly preprocess?: number | null;
  readonly oneShot?: boolean | null;
}

export interface StaticParticlePhase {
  /** True when a frozen one-shot has reached its authored active-window end. */
  readonly expired: boolean;
  /** Initial simulation delta for the representative static frame. */
  readonly warmSeconds: number;
  /** The caller must wake at this point to clear an active frozen one-shot. */
  readonly nextDueMs: number;
}

interface SeenBurst {
  readonly signature: string;
  readonly seenAtMs: number;
}

const STATIC_WARM_ONESHOT_FRACTION = 0.4;
const STATIC_WARM_REPEAT_FRACTION = 1;

function finitePositive(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function activeWindowSeconds(spec: StaticParticleSpec): number {
  const lifetime = finitePositive(spec.lifetime, 0.01);
  const explosiveness = typeof spec.explosiveness === "number" && Number.isFinite(spec.explosiveness)
    ? Math.min(1, Math.max(0, spec.explosiveness))
    : 0;
  return lifetime * (2 - explosiveness);
}

function signature(spec: StaticParticleSpec, emitting: boolean, restartEpoch: number | null): string {
  return [spec.oneShot === true, spec.lifetime ?? "", spec.explosiveness ?? "", spec.preprocess ?? "", emitting, restartEpoch ?? ""].join("|");
}

/**
 * Tracks only the client-side first-sighting clock that frozen one-shots need.
 * The producer's restart epoch is included in the signature, so replaying a
 * burst replaces its retired phase rather than leaving it permanently blank.
 */
export function createStaticParticlePhaseBank() {
  const seen = new Map<string, SeenBurst>();

  return {
    sample(
      id: string,
      spec: StaticParticleSpec,
      emitting: boolean,
      restartEpoch: number | null,
      nowMs: number,
    ): StaticParticlePhase {
      const lifetime = finitePositive(spec.lifetime, 0.01);
      const preprocessed = finitePositive(spec.preprocess, 0) > 0;
      const oneShot = spec.oneShot === true;
      const warmSeconds = preprocessed ? 0 : lifetime * (oneShot ? STATIC_WARM_ONESHOT_FRACTION : STATIC_WARM_REPEAT_FRACTION);
      if (!oneShot || !emitting) {
        if (!emitting) seen.delete(id);
        return { expired: !emitting, warmSeconds, nextDueMs: Number.POSITIVE_INFINITY };
      }
      const key = signature(spec, emitting, restartEpoch);
      const prior = seen.get(id);
      const burst = prior?.signature === key ? prior : { signature: key, seenAtMs: nowMs };
      seen.set(id, burst);
      const dueAtMs = burst.seenAtMs + activeWindowSeconds(spec) * 1000;
      const expired = nowMs >= dueAtMs;
      return { expired, warmSeconds, nextDueMs: expired ? Number.POSITIVE_INFINITY : dueAtMs };
    },
    reconcile(ids: ReadonlySet<string>): void {
      for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id);
    },
    clear(): void {
      seen.clear();
    }
  };
}
