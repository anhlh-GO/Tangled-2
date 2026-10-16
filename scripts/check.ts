// Quick look at the levels as tuned: board, ropes, how careful / careless bots do.
//   node scripts/check.ts [from-to]
import { generate, planOf, shapeOf } from '../src/levels.ts';
import { botRun, crossings, fromSpec, rngOf } from '../src/sim.ts';
const [a, b] = (process.argv[2] ?? '1-10').split('-').map(Number);
for (let i = a - 1; i < b; i++) {
  const t0 = Date.now();
  try {
    const spec = generate(i);
    const s = fromSpec(spec);
    let w = 0, c = 0;
    for (let r = 0; r < 6; r++) if (botRun(s, rngOf(r * 13 + 5), 0.25).win) w++;
    for (let r = 0; r < 20; r++) if (botRun(s, rngOf(r * 31 + 7), 1, 0.2).win) c++;
    console.log(`L${i + 1} ${planOf(i).diff} ${shapeOf(i)} holes ${spec.holes.length} ropes ${spec.ropes.length} X ${crossings(s)} careful ${w}/6 careless ${c}/20 ${Date.now() - t0}ms`);
  } catch (e) { console.log(`L${i + 1} ${shapeOf(i)} FAIL ${(e as Error).message}`); }
}
