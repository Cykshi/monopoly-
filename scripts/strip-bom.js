// Strip leading UTF-8 BOM(s) from a file, touching no other byte.
const fs = require('fs');
const p = process.argv[2];
const buf = fs.readFileSync(p);

let i = 0;
while (i + 2 < buf.length && buf[i] === 0xef && buf[i + 1] === 0xbb && buf[i + 2] === 0xbf) i += 3;

if (i === 0) {
  console.log('no leading BOM — file untouched');
  process.exit(0);
}
fs.writeFileSync(p, buf.subarray(i));
const out = fs.readFileSync(p);
console.log(`stripped ${i} BOM byte(s); first bytes now:`, [...out.slice(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join(' '));
console.log('starts with:', JSON.stringify(out.subarray(0, 14).toString('utf8')));
