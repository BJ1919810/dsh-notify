/**
 * Search the packaged DSH runtime for a string and print the code around each
 * hit.
 *
 * The runtime ships as an Electron asar archive, so the code that produces an
 * error message is not on disk in a readable form. When a host reports
 * something cryptic — "cannot get property \"config\" without inject" — the
 * only way to know which layer raised it is to read the packaged source.
 *
 *   node scripts/asar-grep.mjs --needle "without inject" --asar "D:\\...\\app.asar"
 */
import { readFileSync } from 'node:fs';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[token.slice(2)] = true;
      continue;
    }
    args[token.slice(2)] = next;
    index += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const asarPath = typeof args.asar === 'string' ? args.asar : 'D:\\Deepseek Harness\\resources\\app.asar';
const needle = typeof args.needle === 'string' ? args.needle : 'without inject';
const context = Number(args.context ?? 400);
const maxHits = Number(args.maxHits ?? 4);
const only = typeof args.only === 'string' ? args.only : '';

const archive = readFileSync(asarPath);

// asar header: u32 pickleSize, u32 headerPickleSize, u32 headerStringSize,
// u32 headerJsonLength, then the JSON at 16; payload starts after the header
// pickle.
const headerPickleSize = archive.readUInt32LE(4);
const headerJsonLength = archive.readUInt32LE(12);
const header = JSON.parse(archive.toString('utf8', 16, 16 + headerJsonLength));
const dataStart = 8 + headerPickleSize;

let visited = 0;
let hits = 0;

function walk(node, prefix) {
  if (hits >= maxHits) return;
  if (node.files !== undefined) {
    for (const [name, child] of Object.entries(node.files)) {
      if (hits >= maxHits) return;
      walk(child, `${prefix}/${name}`);
    }
    return;
  }
  if (typeof node.offset !== 'string' && typeof node.offset !== 'number') return;
  if (node.size === 0 || node.size > 6 * 1024 * 1024) return;
  if (!/\.(js|mjs|cjs)$/.test(prefix)) return;
  if (only !== '' && !prefix.includes(only)) return;
  visited += 1;
  const start = dataStart + Number(node.offset);
  const text = archive.toString('utf8', start, start + node.size);
  const index = text.indexOf(needle);
  if (index < 0) return;
  hits += 1;
  const from = Math.max(0, index - context);
  console.log(`\n=== HIT ${hits}: ${prefix} (at ${index}) ===`);
  console.log(text.slice(from, Math.min(text.length, index + context)));
}

walk(header, '');
console.log(`\nscanned=${visited} hits=${hits}`);
