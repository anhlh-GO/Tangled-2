// Fit every level to its difficulty band (BAND / AIM in src/levels.ts): search the
// seed and how far the tray colours stray from the natural order (`mix`), until
// careful play clears the level every time and a careless bot wins at the target rate.
//   node scripts/tune.ts              report only
//   node scripts/tune.ts --write      write src/tuned.ts
//   node scripts/tune.ts --verify      re-check the tuned levels
//   node scripts/tune.ts --range=5-9  (prints one JSON line per level: merge with --merge=file1,file2 --write)
import { readFileSync, writeFileSync } from 'node:fs';
import { AIM, BAND, LEVEL_COUNT, generate, planOf, type Tune } from '../src/levels.ts';
import { TUNED } from '../src/tuned.ts';
import { botRun, fromSpec, rngOf } from '../src/sim.ts';

/** The careless player: mostly untangles, hardly minds the basket colours. */
export const CARELESS = { temp: 1, care: 0.2 };
const RUNS = 40;
const SEEDS = Number(process.argv.find((a) => a.startsWith('--seeds='))?.slice(8) ?? 6);
const args = process.argv.slice(2);
const range = args.find((a) => a.startsWith('--range='))?.slice(8).split('-').map(Number) ?? [1, LEVEL_COUNT];
const out: Tune[] = [...TUNED];

function evaluate(i: number, t: Tune) {
  let spec;
  try { spec = generate(i, t); } catch { return null; }
  const s = fromSpec(spec);
  let careful = 0;
  for (let r = 0; r < 6; r++) if (botRun(s, rngOf(r * 13 + 5), 0.25).win) careful++;
  if (careful < 5) return { t, rate: 0, careful, d: 9, ropes: spec.ropes.length, lossAt: 0 };
  let wins = 0, prog = 0;
  for (let r = 0; r < RUNS; r++) { const res = botRun(s, rngOf(r * 31 + 7), CARELESS.temp, CARELESS.care); if (res.win) wins++; else prog += res.progress; }
  const p = planOf(i);
  const rate = wins / RUNS;
  const [lo, hi] = BAND[p.diff];
  let d = rate < lo ? lo - rate : rate > hi ? rate - hi : Math.abs(rate - AIM[p.diff]) * 0.05;
  if (careful < 6) d += (6 - careful) * 0.2;   // careful play must clear it every time: no level that just jams
  return { t, rate, careful, d, ropes: spec.ropes.length, lossAt: wins < RUNS ? prog / (RUNS - wins) : 1 };
}

const merge = args.find((a) => a.startsWith('--merge='))?.slice(8).split(',');
if (args.includes('--verify')) {
  // re-check the levels as tuned now (after a change to shapes or rules)
  for (let i = range[0] - 1; i < range[1]; i++) {
    const r = evaluate(i, TUNED[i]);
    const p = planOf(i);
    console.log(`L${i + 1} ${p.diff} bot ${r ? Math.round(r.rate * 100) : '-'}% careful ${r?.careful ?? 0}/6${!r || r.d >= 0.05 ? '  OFF' : ''}`);
  }
} else if (merge) {
  for (const f of merge) for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^JSON (.*)$/);
    if (m) { const o = JSON.parse(m[1]); out[o.i] = o.t; }
  }
} else for (let i = range[0] - 1; i < range[1]; i++) {
  const p = planOf(i);
  const [lo, hi] = BAND[p.diff];
  let best: NonNullable<ReturnType<typeof evaluate>> | null = null;
  const mixes = p.diff === 'easy' ? [0, 0.1, 0.2] : p.diff === 'normal' ? [0.15, 0.3, 0.45, 0.6] : [0.35, 0.5, 0.7, 0.9];
  search: for (const mix of mixes) {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = evaluate(i, { seed, mix });
      if (!r) continue;
      if (!best || r.d < best.d) best = r;
      if (r.d < 0.015) break search;
    }
  }
  if (!best) { console.log(`L${i + 1}: nothing playable`); continue; }
  out[i] = best.t;
  console.log(`L${i + 1} ${p.diff.padEnd(6)} ${p.colors}c ropes ${best.ropes} mix ${best.t.mix} seed ${best.t.seed}  bot ${Math.round(best.rate * 100)}% [${lo * 100 | 0}-${hi * 100 | 0}] careful ${best.careful}/6  lossAt ${Math.round(best.lossAt * 100)}%${best.d >= 0.05 ? '  OFF' : ''}`);
  console.log('JSON ' + JSON.stringify({ i, t: best.t }));
}

if (args.includes('--write')) {
  const body = out.map((t) => `  { seed: ${t.seed}, mix: ${t.mix} },`).join('\n');
  writeFileSync(new URL('../src/tuned.ts', import.meta.url), `// Written by scripts/tune.ts --write\nimport type { Tune } from './levels.ts';\n\nexport const TUNED: Tune[] = [\n${body}\n];\n`);
  console.log('wrote src/tuned.ts');
}
