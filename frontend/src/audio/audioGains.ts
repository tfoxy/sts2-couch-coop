import type { SeatAudioEvent } from "./audioWire";

export interface SeatVolumes {
  master: number; sfx: number; bgm: number; ambience: number;
  godotMasterDb: number; godotSfxDb: number;
}

export const DEFAULT_SEAT_VOLUMES: SeatVolumes = {
  master: 1, sfx: 1, bgm: 1, ambience: 1, godotMasterDb: 0, godotSfxDb: 0
};

const unit = (v: number | undefined, fallback = 1): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback;
const eventVolume = (v: number): number => Number.isFinite(v) && v > 0 ? v : 0;
export const dbToLinear = (db: number): number => db === Number.NEGATIVE_INFINITY ? 0 :
  Number.isFinite(db) ? Math.pow(10, db / 20) : 0;

export function applyVolumeSnapshot(current: SeatVolumes, event: Extract<SeatAudioEvent, { kind: "volumes" }>): SeatVolumes {
  const dbValue = (value: number | "-Infinity" | undefined, fallback: number): number =>
    value === "-Infinity" ? Number.NEGATIVE_INFINITY :
      typeof value === "number" && (Number.isFinite(value) || value === Number.NEGATIVE_INFINITY) ? value : fallback;
  return {
    master: unit(event.master, current.master), sfx: unit(event.sfx, current.sfx),
    bgm: unit(event.bgm, current.bgm), ambience: unit(event.ambience, current.ambience),
    godotMasterDb: dbValue(event.godotMasterDb, current.godotMasterDb),
    godotSfxDb: dbValue(event.godotSfxDb, current.godotSfxDb)
  };
}

export function hasVolumeSnapshot(event: Extract<SeatAudioEvent, { kind: "volumes" }>): boolean {
  return event.snapshot;
}

export function sfxEventGain(volumes: SeatVolumes, event: Extract<SeatAudioEvent, { kind: "sfx" | "tmpsfx" }>): number {
  if (event.kind === "tmpsfx") return unit(volumes.master) === 0 || unit(volumes.sfx) === 0 ? 0 :
    dbToLinear(volumes.godotMasterDb + volumes.godotSfxDb) * eventVolume(event.volume);
  return unit(volumes.master) ** 2 * unit(volumes.sfx) ** 2 * eventVolume(event.volume);
}

export function laneGain(volumes: SeatVolumes, lane: "music" | "ambience" | "loops"): number {
  const bus = lane === "music" ? volumes.bgm : lane === "ambience" ? volumes.ambience : volumes.sfx;
  return unit(volumes.master) ** 2 * unit(bus) ** 2;
}
