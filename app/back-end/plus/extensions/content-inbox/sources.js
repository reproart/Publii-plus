/**
 * Where inbox files come from:
 *   github – a folder of a GitHub repository (git trees/blobs API; a token is needed for private repositories)
 *   folder – a local folder (for example a git checkout updated by "git pull" on an always-on machine)
 *
 * source.list()      -> [{ path, sha, size }]   path is relative to the inbox folder, "/" separators
 * source.read(path)  -> Buffer
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILE = 20 * 1024 * 1024;
const MAX_FILES = 2000;

function defaultFetch () {
    if (process.versions.electron) {
        try {
            const { net } = require('electron');
            if (net && net.fetch) return net.fetch.bind(net);
        } catch (e) { /* not in Electron */ }
    }

    return globalThis.fetch;
}

function cleanFolder (folder) {
    const value = String(folder || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

    if (value.split('/').some(part => part === '..')) throw new Error('Invalid folder.');
    return value;
}

/** git's blob hash, so local and GitHub files compare the same way */
function gitBlobSha (buffer) {
    return crypto.createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
}

function githubSource ({ owner, repo, branch = 'main', folder = '', token = '', apiBase = 'https://api.github.com', fetchImpl }) {
    if (!/^[\w.-]+$/.test(owner || '') || !/^[\w.-]+$/.test(repo || '')) throw new Error('Enter the repository as owner/name.');

    const prefix = cleanFolder(folder);
    const fetchFn = () => fetchImpl || defaultFetch();
    let entries = null;

    async function request (url) {
        const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Publii-Plus' };

        if (token) headers.Authorization = 'Bearer ' + token;

        let response;

        try {
            response = await fetchFn()(url, { headers });
        } catch (e) {
            throw new Error(`Cannot connect to ${new URL(url).host}: ${e.cause && e.cause.code ? e.cause.code : e.message}`);
        }

        if (!response.ok) {
            const hint = response.status === 404 ? ' – repository, branch or folder not found (a private repository needs a token)'
                : response.status === 401 ? ' – the access token is invalid'
                    : response.status === 403 ? ' – access denied or API rate limit reached (add a token)' : '';
            throw new Error(`GitHub answered HTTP ${response.status}${hint}.`);
        }

        return response.json();
    }

    return {
        type: 'github',
        label: `github.com/${owner}/${repo}/${branch}${prefix ? '/' + prefix : ''}`,
        async list () {
            const tree = await request(`${apiBase}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);

            if (tree.truncated) throw new Error('The repository is too large for one listing – use a smaller repository for the inbox.');

            entries = (tree.tree || [])
                .filter(e => e.type === 'blob' && (!prefix || e.path.startsWith(prefix + '/')))
                .map(e => ({ path: prefix ? e.path.slice(prefix.length + 1) : e.path, sha: e.sha, size: e.size || 0 }))
                .slice(0, MAX_FILES);

            return entries;
        },
        async read (rel) {
            if (!entries) await this.list();

            const entry = entries.find(e => e.path === rel);

            if (!entry) throw new Error(`File not found in the repository: ${rel}`);
            if (entry.size > MAX_FILE) throw new Error(`File too large: ${rel}`);

            const blob = await request(`${apiBase}/repos/${owner}/${repo}/git/blobs/${entry.sha}`);
            return Buffer.from(blob.content || '', blob.encoding === 'base64' ? 'base64' : 'utf8');
        }
    };
}

function folderSource ({ dir }) {
    const root = path.resolve(String(dir || ''));

    if (!dir || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('The inbox folder does not exist.');

    const resolve = rel => {
        const target = path.resolve(root, rel);

        if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Invalid file path.');
        return target;
    };

    return {
        type: 'folder',
        label: root,
        async list () {
            const out = [];
            const walk = (current, relBase) => {
                for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                    if (out.length >= MAX_FILES || entry.name === '.git' || entry.name === 'node_modules') continue;

                    const full = path.join(current, entry.name);
                    const rel = relBase ? relBase + '/' + entry.name : entry.name;

                    if (entry.isDirectory()) walk(full, rel);
                    else if (entry.isFile()) {
                        const stat = fs.statSync(full);
                        out.push({ path: rel, size: stat.size, sha: stat.size <= MAX_FILE ? gitBlobSha(fs.readFileSync(full)) : 'too-large' });
                    }
                }
            };

            walk(root, '');
            return out;
        },
        async read (rel) {
            const file = resolve(rel);

            if (fs.statSync(file).size > MAX_FILE) throw new Error(`File too large: ${rel}`);
            return fs.readFileSync(file);
        }
    };
}

function createSource (config, { token, apiBase, fetchImpl } = {}) {
    if (config.source === 'folder') return folderSource({ dir: config.dir });

    const [owner, repo] = String(config.repo || '').split('/');
    return githubSource({ owner, repo, branch: config.branch || 'main', folder: config.folder || '', token, apiBase, fetchImpl });
}

module.exports = { createSource, githubSource, folderSource, gitBlobSha, cleanFolder };
