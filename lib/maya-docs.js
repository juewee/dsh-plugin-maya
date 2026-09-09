/**
 * Offline Maya command documentation store.
 *
 * Data is the Autodesk Maya CHS Tech-Docs scrape produced by the `maya-doc`
 * project: per version `index.json` (name -> category/subcategory/isMelScript)
 * plus `maya_commands_python.json` (name -> description/examples/url).
 *
 * The JSON files are multi-megabyte, so they are parsed lazily, once per
 * process per version, and kept as Maps. Nothing is ever handed to the model
 * whole: every tool renders a compact projection.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const VERSION_PATTERN = /^\d{4}$/;

/** Collapse whitespace and cut a description down to one readable line. */
export function summarize(text, limit = 160) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '), cut.lastIndexOf(', '));
  return (lastStop > limit * 0.5 ? cut.slice(0, lastStop) : cut).trim() + '...';
}

/** Normalize one index entry into a category label list. */
function categoryLabels(entry) {
  if (!entry || typeof entry !== 'object') return [];
  if (Array.isArray(entry.categories)) {
    return entry.categories
      .map((item) => [item.category, item.subcategory].filter(Boolean).join(' / '))
      .filter(Boolean);
  }
  const label = [entry.category, entry.subcategory].filter(Boolean).join(' / ');
  return label ? [label] : [];
}

/** One loaded documentation version: index + command bodies. */
class VersionData {
  constructor(version, root) {
    this.version = version;
    this.root = root;
    /** @type {Map<string, object>} */
    this.index = new Map();
    /** @type {Map<string, object>} */
    this.commands = new Map();
    this.meta = null;
  }

  async load() {
    if (this.meta) return this;
    const dir = join(this.root, this.version);
    const [indexRaw, commandsRaw] = await Promise.all([
      readFile(join(dir, 'index.json'), 'utf8'),
      readFile(join(dir, 'maya_commands_python.json'), 'utf8'),
    ]);
    const index = JSON.parse(indexRaw);
    for (const [name, entry] of Object.entries(index)) this.index.set(name, entry);
    const commands = JSON.parse(commandsRaw);
    this.meta = commands.meta ?? { version: 'Maya ' + this.version };
    for (const entry of commands.commands ?? []) {
      if (entry && typeof entry.name === 'string') this.commands.set(entry.name, entry);
    }
    return this;
  }

  /** Merged view of one command: index metadata plus doc body. */
  entry(name) {
    const meta = this.index.get(name) ?? null;
    const body = this.commands.get(name) ?? null;
    return {
      name,
      version: this.version,
      categories: categoryLabels(meta),
      isMelScript: meta?.isMelScript ?? null,
      description: body?.description ?? '',
      examples: body?.examples ?? '',
      url: body?.url ?? '',
      error: body?.error ?? null,
      documented: Boolean(body),
    };
  }

  /** Category tree with command counts. */
  categories() {
    const tree = new Map();
    for (const [name, meta] of this.index) {
      const labels = categoryLabels(meta);
      const effective = labels.length > 0 ? labels : ['(uncategorized)'];
      for (const label of effective) {
        const [category, subcategory = '(none)'] = label.split(' / ');
        if (!tree.has(category)) tree.set(category, new Map());
        const bucket = tree.get(category);
        if (!bucket.has(subcategory)) bucket.set(subcategory, []);
        bucket.get(subcategory).push(name);
      }
    }
    return tree;
  }

  /** Score one command against a query, or -1 when it does not match at all. */
  score(name, query) {
    const lower = name.toLowerCase();
    const q = query.toLowerCase();
    if (lower === q) return 1000;
    if (lower.startsWith(q)) return 800 - Math.min(lower.length - q.length, 200);
    if (lower.includes(q)) return 600 - Math.min(lower.indexOf(q), 200);
    const entry = this.entry(name);
    const haystack = (entry.description + ' ' + entry.categories.join(' ')).toLowerCase();
    if (haystack.includes(q)) return 300;
    const tokens = q.split(/[^a-z0-9_]+/).filter(Boolean);
    if (tokens.length > 1 && tokens.every((token) => haystack.includes(token) || lower.includes(token))) return 200;
    return -1;
  }
}

/** Lazily loaded, cached documentation store rooted at a data directory. */
export class MayaDocStore {
  /** @param {string} root directory containing `<version>/index.json` trees. */
  constructor(root) {
    this.root = root;
    /** @type {Map<string, Promise<VersionData>>} */
    this.loading = new Map();
  }

  /** Available documentation versions, newest first. */
  async versions() {
    let entries = [];
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      throw new Error('Maya documentation directory is unreadable: ' + this.root + ' (' + error.code + ')');
    }
    return entries
      .filter((entry) => entry.isDirectory() && VERSION_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  }

  /** Resolve the version to use, validating an explicit request. */
  async resolveVersion(requested, fallback) {
    const available = await this.versions();
    if (available.length === 0) throw new Error('no Maya documentation versions found under ' + this.root);
    if (requested) {
      if (!available.includes(requested)) {
        throw new Error('unknown Maya documentation version ' + requested + '; available: ' + available.join(', '));
      }
      return requested;
    }
    if (fallback && available.includes(fallback)) return fallback;
    return available[0];
  }

  /** Load (and cache) one version. */
  async get(requested, fallback) {
    const version = await this.resolveVersion(requested, fallback);
    if (!this.loading.has(version)) {
      const data = new VersionData(version, this.root);
      this.loading.set(version, data.load());
    }
    return this.loading.get(version);
  }

  /** Load every version's metadata for the status tool. */
  async summaries() {
    const versions = await this.versions();
    const out = [];
    for (const version of versions) {
      const data = await this.get(version);
      out.push({ version, meta: data.meta, commands: data.commands.size, indexed: data.index.size });
    }
    return out;
  }

  /**
   * Search one version.
   * @returns {Promise<{version: string, total: number, matched: number, results: object[]}>}
   */
  async search({ query, version, fallbackVersion, category, limit = 15 }) {
    const data = await this.get(version, fallbackVersion);
    const categoryFilter = category ? category.toLowerCase() : null;
    const scored = [];
    for (const name of data.index.keys()) {
      if (categoryFilter) {
        const labels = categoryLabels(data.index.get(name)).join(' ').toLowerCase();
        if (!labels.includes(categoryFilter)) continue;
      }
      const score = data.score(name, query);
      if (score >= 0) scored.push([score, name]);
    }
    scored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
    const selected = scored.slice(0, limit).map(([, name]) => {
      const entry = data.entry(name);
      return {
        name: entry.name,
        categories: entry.categories,
        isMelScript: entry.isMelScript,
        summary: summarize(entry.description),
        hasExamples: Boolean(entry.examples),
        url: entry.url,
        error: entry.error,
      };
    });
    return { version: data.version, total: data.index.size, matched: scored.length, results: selected };
  }

  /** Full documentation for named commands. */
  async getCommands({ names, version, fallbackVersion, maxExampleChars = 2500 }) {
    const data = await this.get(version, fallbackVersion);
    const commands = names.map((name) => {
      const entry = data.entry(name);
      const examples = entry.examples.length > maxExampleChars
        ? entry.examples.slice(0, maxExampleChars) + '\n# ... (truncated by dsh-plugin-maya)'
        : entry.examples;
      return {
        name: entry.name,
        known: data.index.has(name) || data.commands.has(name),
        categories: entry.categories,
        isMelScript: entry.isMelScript,
        description: entry.description,
        examples,
        url: entry.url,
        error: entry.error,
      };
    });
    return { version: data.version, commands };
  }

  /** Category tree for one version. */
  async categoryTree({ version, fallbackVersion }) {
    const data = await this.get(version, fallbackVersion);
    const tree = data.categories();
    const categories = [...tree.entries()]
      .map(([category, bucket]) => ({
        category,
        commandCount: new Set([...bucket.values()].flat()).size,
        subcategories: [...bucket.entries()]
          .map(([subcategory, names]) => ({ subcategory, commandCount: names.length }))
          .sort((a, b) => b.commandCount - a.commandCount || a.subcategory.localeCompare(b.subcategory)),
      }))
      .sort((a, b) => b.commandCount - a.commandCount || a.category.localeCompare(b.category));
    return { version: data.version, categories };
  }
}
