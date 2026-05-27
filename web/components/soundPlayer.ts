let ctx: AudioContext | null = null;

export function enableSound(): void {
  if (ctx) return;
  ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
}

export function beep(freq = 880, durationMs = 200): void {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationMs / 1000);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + durationMs / 1000);
}

export function alertBeep(direction: 'up' | 'down'): void {
  beep(direction === 'up' ? 1046 : 659, 300);
}
