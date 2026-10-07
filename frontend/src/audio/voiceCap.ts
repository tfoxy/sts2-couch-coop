export interface VoiceRecord { keyId: string; stop(fadeMs: number): void; }
export class VoiceCap {
  private readonly active = new Map<string, VoiceRecord[]>();
  constructor(private readonly maximumPerKey = 4) {}
  add(voice: VoiceRecord): void {
    const list = this.active.get(voice.keyId) ?? [];
    while (list.length >= this.maximumPerKey) list.shift()!.stop(10);
    list.push(voice); this.active.set(voice.keyId, list);
  }
  remove(voice: VoiceRecord): void {
    const list = this.active.get(voice.keyId); if (!list) return;
    const i = list.indexOf(voice); if (i >= 0) list.splice(i, 1);
    if (!list.length) this.active.delete(voice.keyId);
  }
  count(): number { let n = 0; for (const voices of this.active.values()) n += voices.length; return n; }
  stopAll(): void { for (const voices of this.active.values()) for (const v of voices) v.stop(10); this.active.clear(); }
}
