#!/bin/zsh
# Make (or go on making) all 100 levels, then write src/levelData.ts and build.
# Progress is kept in .gen-levels/ (one file per range): levels already there are skipped,
# so this can be stopped (machine off) and run again — it carries on where it left off.
#   ./scripts/gen-all.sh
cd "$(dirname "$0")/.."
O=.gen-levels
mkdir -p $O
# 8 ranges at once (one per CPU core); the Mac stays awake while they run
for r in 1-13 14-26 27-39 40-52 53-65 66-78 79-90 91-100; do
  node scripts/gen-levels.ts $r --out=$O/lv_$r.txt >> $O/log_$r.txt 2>&1 &
done
caffeinate -i -s -w $! &
wait
# levels still missing: other seeds, all at once
missing=$(node -e "
const fs=require('fs');const have=new Set();
for(const f of fs.readdirSync('$O').filter(x=>x.startsWith('lv_')))for(const l of fs.readFileSync('$O/'+f,'utf8').split('\n')){const m=l.match(/^JSON \{\"i\":(\d+),/);if(m)have.add(+m[1]);}
const out=[];for(let i=0;i<100;i++)if(!have.has(i))out.push(i+1);console.log(out.join(' '));")
echo "retrying: ${missing:-none}"
for l in ${=missing}; do
  node scripts/gen-levels.ts $l-$l --from-attempt=80 --out=$O/lv_retry_$l.txt >> $O/log_retry_$l.txt 2>&1 &
done
wait
# write src/levelData.ts from everything made, then build
python3 - <<'PY'
p='src/levelData.ts'
s=open(p).read(); i=s.index('export const LEVEL_DATA')
open(p,'w').write(s[:i]+'export const LEVEL_DATA: LevelData[] = [];\n')
PY
node scripts/gen-levels.ts --merge=$(ls $O/lv_*.txt | tr '\n' ',' | sed 's/,$//')
npm run build 2>&1 | tail -2
