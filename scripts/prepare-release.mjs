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
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
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
// The English description contains a colon followed by a space, and in YAML
// that is a mapping separator at any depth: unquoted, `finishes: the session
// title` turns the rest of the sentence into a nested map and the whole file
// stops parsing. The catalog's own guide calls this out; every existing entry
// with a colon in it is quoted. Quoting is always safe, so both descriptions get
// single quotes (inside which the apostrophe-free text needs no escaping).
const EN_DESCRIPTION =
  'Windows toast notifications when a DeepSeek Harness task finishes: the session title, the outcome, and a summary of the final reply, sent once when the agent really stops rather than once per round of a running goal.';
const ZH_DESCRIPTION =
  'DSH 任务完成时，在 Windows 通知栏弹出原生通知，带上会话标题、结果状态与最后一条回复的摘要；在 agent 真正停下来时才发一条，而不是每跑一个回合就响一次。';

// Refuse to write an entry that does not parse. A YAML syntax error here is
// invisible until the pull request's CI runs, which is the worst place to find
// out — the file looks fine on screen.
if (EN_DESCRIPTION.includes("'") || ZH_DESCRIPTION.includes("'")) {
  process.stderr.write('refusing: a description contains an apostrophe, which this quoting cannot carry\n');
  process.exit(1);
}

const entry = [
  `url: ${base}`,
  `name: ${owner}/${repo}`,
  'category: notify',
  'description:',
  `  en: '${EN_DESCRIPTION}'`,
  `  zh: '${ZH_DESCRIPTION}'`,
  '',
].join('\n');

// Round-trip the entry through a real parser. A YAML syntax error here is
// invisible until the catalog's CI runs, which is the worst place to find out —
// the file looks fine on screen. `js-yaml` ships with the running DSH profile
// rather than with this package, so no parser means a skip, not a failure.
function loadYaml() {
  const require = createRequire(import.meta.url);
  for (const candidate of [
    'js-yaml',
    join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'js-yaml'),
  ]) {
    try {
      return require(candidate);
    } catch {
      // Try the next location.
    }
  }
  return undefined;
}

const yaml = loadYaml();
if (yaml === undefined) {
  process.stdout.write('note  js-yaml not found; the entry was not round-tripped\n');
} else {
  let parsed;
  try {
    parsed = yaml.load(entry);
  } catch (error) {
    process.stderr.write(`refusing to write an unparseable entry: ${error.message}\n`);
    process.exit(1);
  }
  // Read the values back out rather than trusting the string that was written:
  // that is the whole point of the round trip.
  const url = parsed?.url;
  const descriptions = parsed?.description;
  if (url !== base || typeof descriptions?.en !== 'string' || typeof descriptions?.zh !== 'string') {
    process.stderr.write('refusing: the entry did not parse back to the intended values\n');
    process.exit(1);
  }
  process.stdout.write('ok    the entry parses as YAML and keeps its values\n');
}

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
