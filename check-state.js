// Report which markers of which UI state are present in page.tsx.
const fs = require('fs');
const s = fs.readFileSync('frontend/app/page.tsx', 'utf8');

const checks = [
  ['full-screen lobby GATE (fixed inset-0)', 'fixed inset-0 z-[9999] flex items-center justify-center'],
  ['lobby as BANNER (normal flow)', 'mb-[1vmin] flex justify-center'],
  ['LOBBY GATE comment', 'LOBBY GATE'],
  ['LOBBY BAR comment', 'LOBBY BAR'],
  ['main has flex-col', 'h-screen w-screen flex-col items-center'],
  ['main is row (original)', 'h-screen w-screen items-center justify-start'],
  ['big Monopoly h1 in lobby', 'text-center text-[3vmin] font-black uppercase tracking-widest'],
  ['room-code header missing flex', 'mb-[1.2vmin] flex-col gap-[0.8vmin]'],
  ['room-code header HAS flex', 'mb-[1.2vmin] flex-col gap-[0.8vmin]'],
  ['create button label', 'Create a Room'],
];

for (const [name, needle] of checks) {
  console.log((s.includes(needle) ? 'PRESENT  ' : 'absent   ') + name);
}
