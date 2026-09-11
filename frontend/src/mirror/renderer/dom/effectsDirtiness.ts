// The DOM renderer exposes effect invalidation as two independent bits. Keep this tiny stateful
// phase separate from the walk so callers cannot accidentally clear one runtime while marking another.

export interface EffectsDirty {
  markAll(): void;
  markBits(bits: number): void;
  markShader(): void;
  markParticle(): void;
  consume(): { shader: boolean; particle: boolean };
}

export function createEffectsDirtiness(shaderBit: number, particleBit: number): EffectsDirty {
  // Start dirty: a consumer may reconcile its runtimes before the first scene walk.
  let shader = true;
  let particle = true;

  return {
    markAll() {
      shader = true;
      particle = true;
    },
    markBits(bits) {
      if (bits & shaderBit) shader = true;
      if (bits & particleBit) particle = true;
    },
    markShader() {
      shader = true;
    },
    markParticle() {
      particle = true;
    },
    consume() {
      const dirty = { shader, particle };
      shader = false;
      particle = false;
      return dirty;
    }
  };
}
