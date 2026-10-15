/**
 * Fill in the repository coordinates the package needs before it can be
 * published or listed.
 *
 * `package.json`'s `repository`, `homepage` and `bugs` fields, the README's
 * links, and the catalog entry all have to agree: the catalog's CI checks that
 * the published npm package's `repository` points back at the listed
 * repository. That is the kind of mistake which only shows up after a merge, so
 * it is done in one place, by a script, and printed for review.
 *
 *   node scripts/prepare-release.mjs --owner <github-user-or-org> [--repo dsh-notify]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLACEHOLDER = 'OWNER';
const DEFAULT_REPO = 'dsh-notify';

/** `--key value` and bare `--flag` pairs, without a dependency. */
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const owner = typeof args.owner === 'string' ? args.owner.trim() : '';
const repo = typeof args.repo === 'string' && args.repo.trim() !== '' ? args.repo.trim() : DEFAULT_REPO;

if (owner === '' || owner === PLACEHOLDER) {
  process.stderr.write(
    'usage: node scripts/prepare-release.mjs --owner <github-user-or-org> [--repo dsh-notify]\n\n' +
      'The owner is the GitHub account that will host the repository. It has to be the\n' +
      'account named in the catalog entry, because the catalog links the two together.\n',
  );
  process.exit(2);
}

const base = `https://github.com/${owner}/${repo}`;

const packagePath = join(root, 'package.json');
const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
manifest.repository = { type: 'git', url: `git+${base}.git` };
manifest.homepage = `${base}#readme`;
manifest.bugs = { url: `${base}/issues` };
// Two-space indent, the same shape npm writes, so a later `npm version` does not
// turn into a whole-file diff.
writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write(`package.json   repository/homepage/bugs -> ${base}\n`);

const readmePath = join(root, 'README.md');
const readme = readFileSync(readmePath, 'utf8');
writeFileSync(readmePath, readme.split(PLACEHOLDER).join(owner), 'utf8');
process.stdout.write(`README.md      ${PLACEHOLDER} -> ${owner}\n`);

// The catalog entry lives in a different repository (a PR against
// awesome-dsh-plugin). Writing it here keeps one copy of the description and
// makes it impossible for the link to drift from package.json.
const entryDir = join(root, 'release', 'awesome-dsh-plugin');
mkdirSync(entryDir, { recursive: true });
const entryName = `${owner}__${repo}.yml`;
const entry = [
  `url: ${base}`,
  `name: ${owner}/${repo}`,
  'category: notify',
  'description:',
  '  en: Windows toast notifications when a DeepSeek Harness task finishes: the session title, the outcome, and a summary of the final reply, sent once when the agent really stops rather than once per round of a running goal.',
  '  zh: DSH 任务完成时在 Windows 通知栏弹出原生通知，带上会话标题、结果状态与最后一条回复的摘要；在 agent 真正停下来时才发一条，而不是每跑一个回合就响一次。',
  '',
].join('\n');
writeFileSync(join(entryDir, entryName), entry, 'utf8');
process.stdout.write(`release/awesome-dsh-plugin/${entryName}\n`);

process.stdout.write(
  '\nNext:\n' +
    `  1. git init && git add -A && git commit -m "dsh-notify 0.1.0"\n` +
    `     git remote add origin ${base}.git && git push -u origin main\n` +
    '  2. npm run release:check    # everything the catalog CI will check\n' +
    '  3. uncomment the tarball/npm note in the entry if you publish to npm\n' +
    `  4. open one PR adding release/awesome-dsh-plugin/${entryName} to\n` +
    '     awesome-dsh-plugin as data/plugins/<same name>\n',
);
