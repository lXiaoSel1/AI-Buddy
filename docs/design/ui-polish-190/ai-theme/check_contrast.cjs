const fs=require('fs');
const h=fs.readFileSync(process.argv[2],'utf8');
const pick=(a,b)=>h.slice(h.indexOf(a)+a.length,h.indexOf(b));
const code=pick('/*THEMES-START*/','/*THEMES-END*/')+pick('/*CONTRAST-START*/','/*CONTRAST-END*/')+';module.exports={THEMES,checks};';
const m={exports:{}};new Function('module',code)(m);
let bad=0;
for(const t of m.exports.THEMES){const r=m.exports.checks(t);const f=r.filter(x=>x.r<x.need);bad+=f.length;
  const min=r.reduce((a,x)=>x.r/x.need<a.r/a.need?x:a);
  console.log(t.id.padEnd(9),f.length?'FAIL '+f.map(x=>x.label+' '+x.r.toFixed(2)+'<'+x.need+' ('+x.fg+' on '+x.bg+')').join('; '):'ok   lowest: '+min.label+' '+min.r.toFixed(2));}
console.log('total failures',bad);process.exit(bad?1:0);
