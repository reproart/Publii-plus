/**
 * Publii Plus extension "theme-editor": edit theme files of a website through overrides.
 *
 * Publii renders a website with its copy of the theme in <site>/input/themes/<theme>/ and, for every
 * file, prefers <site>/input/themes/<theme>-override/<same path> when it exists. The editor never
 * touches the theme copy: saving writes the override, "revert" deletes it. Updating the theme
 * therefore keeps the user's changes.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createUnifiedDiff } = require('../../lib/unified-diff');

const EDITABLE = /\.(hbs|handlebars|html?|css|scss|js|mjs|json|txt|md|xml|xsl|svg)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__MACOSX']);
const MAX_FILE_SIZE = 1024 * 1024;
const MAX_FILES = 3000;

function isSafeSegment (name) {
    return typeof name === 'string' && name.length > 0 && name.length < 200 && !/[\\/]/.test(name) && name !== '.' && name !== '..';
}

/** Normalize a relative path from the renderer; throws on anything that could escape the theme. */
function safeRelative (rel) {
    const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = clean.split('/').filter(Boolean);

    if (!parts.length || parts.some(p => p === '..' || p === '.' || p.includes('\0'))) {
        throw new Error('Invalid file path.');
    }

    return parts.join('/');
}

function within (base, rel) {
    const full = path.resolve(base, ...rel.split('/'));

    if (full !== base && !full.startsWith(base + path.sep)) throw new Error('Invalid file path.');

    return full;
}

/** Licence files shipped with every bundled web font – noise in the editor. */
function isFontLicense (rel) {
    return /(^|\/)fonts\//i.test(rel) && /\.(txt|md)$/i.test(rel);
}

function walk (dir, prefix = '', out = []) {
    if (!fs.existsSync(dir)) return out;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= MAX_FILES) break;
        if (entry.name.startsWith('.') && entry.name !== '.htaccess') continue;

        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), rel, out);
        } else if (entry.isFile() && EDITABLE.test(entry.name) && !isFontLicense(rel)) {
            out.push(rel);
        }
    }

    return out;
}

function lineFromOffset (text, offset) {
    return String(text).slice(0, offset).split('\n').length;
}

/**
 * Syntax check before saving. Returns { errors: [{ line, message }], warnings: [...] }.
 * Errors block saving (they would break rendering); warnings do not.
 */
function validateContent (rel, content, { Handlebars } = {}) {
    const errors = [];
    const warnings = [];
    const ext = path.extname(rel).toLowerCase();

    if (ext === '.hbs' || ext === '.handlebars') {
        try {
            (Handlebars || require('handlebars')).precompile(String(content));
        } catch (e) {
            const m = String(e.message).match(/line (\d+)/i);
            errors.push({ line: m ? Number(m[1]) : null, message: String(e.message).split('\n').filter(Boolean).slice(0, 3).join(' ') });
        }
    } else if (ext === '.json') {
        try {
            JSON.parse(String(content));
        } catch (e) {
            const m = String(e.message).match(/position (\d+)/);
            const lm = String(e.message).match(/line (\d+)/);
            errors.push({ line: lm ? Number(lm[1]) : (m ? lineFromOffset(content, Number(m[1])) : null), message: e.message });
        }
    } else if (ext === '.js' || ext === '.mjs') {
        try {
            new vm.Script(String(content), { filename: rel });
        } catch (e) {
            const isModuleSyntax = /import statement|export|Cannot use import|import\.meta/.test(e.message);
            const stackLine = String(e.stack || '').match(new RegExp(rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(\\d+)'));
            const issue = { line: stackLine ? Number(stackLine[1]) : null, message: e.message };

            // ES modules cannot be checked as scripts – report as a warning instead of blocking
            if (ext === '.mjs' || isModuleSyntax) warnings.push({ ...issue, message: 'Not checked as an ES module: ' + e.message });
            else errors.push(issue);
        }
    } else if (ext === '.css' || ext === '.scss') {
        const text = String(content).replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
        const open = (text.match(/\{/g) || []).length;
        const close = (text.match(/\}/g) || []).length;

        if (open !== close) warnings.push({ line: null, message: `Unbalanced braces: ${open} "{" and ${close} "}".` });
    }

    return { errors, warnings };
}

function removeEmptyDirs (dir, stopAt) {
    let current = dir;

    // remove empty folders up to and including the override root
    while (current === stopAt || current.startsWith(stopAt + path.sep)) {
        if (fs.existsSync(current) && fs.readdirSync(current).length === 0) {
            fs.rmdirSync(current);

            if (current === stopAt) break;

            current = path.dirname(current);
        } else {
            break;
        }
    }
}

function createService ({ getSitesDir, Handlebars, showSaveDialog }) {
    function dirs (siteName) {
        if (!isSafeSegment(siteName)) throw new Error('Invalid website.');

        const sitesDir = getSitesDir();

        if (!sitesDir) throw new Error('The websites folder is not available.');

        const siteDir = path.resolve(sitesDir, siteName);
        const configPath = path.join(siteDir, 'input', 'config', 'site.config.json');
        let theme = '';

        try {
            theme = JSON.parse(fs.readFileSync(configPath, 'utf8')).theme || '';
        } catch (e) {
            throw new Error('Cannot read the website configuration.');
        }

        if (!isSafeSegment(theme)) throw new Error('The website has no theme selected.');

        const themesDir = path.join(siteDir, 'input', 'themes');
        return {
            theme,
            themeDir: path.join(themesDir, theme),
            overrideDir: path.join(themesDir, theme + '-override')
        };
    }

    function readIf (file) {
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
        if (fs.statSync(file).size > MAX_FILE_SIZE) throw new Error('The file is too large to edit here (over 1 MB).');

        return fs.readFileSync(file, 'utf8');
    }

    function fileState (siteName, rel) {
        const d = dirs(siteName);
        const safe = safeRelative(rel);
        const originalPath = within(d.themeDir, safe);
        const overridePath = within(d.overrideDir, safe);

        return { d, safe, originalPath, overridePath, original: readIf(originalPath), override: readIf(overridePath) };
    }

    function diffFor (safe, original, override) {
        return createUnifiedDiff(original, override, { oldName: 'a/' + safe, newName: 'b/' + safe });
    }

    const service = {
        /** Text files of the theme and its override. */
        list (siteName) {
            const d = dirs(siteName);
            const original = new Set(walk(d.themeDir));
            const override = new Set(walk(d.overrideDir));
            const files = [...new Set([...original, ...override])].sort((a, b) => a.localeCompare(b)).map(rel => ({
                path: rel,
                overridden: override.has(rel),
                onlyInOverride: override.has(rel) && !original.has(rel)
            }));

            return { theme: d.theme, files, themeExists: fs.existsSync(d.themeDir) };
        },

        read (siteName, rel) {
            const s = fileState(siteName, rel);

            if (s.original === null && s.override === null) throw new Error('File not found.');

            return { path: s.safe, original: s.original, override: s.override, content: s.override !== null ? s.override : s.original };
        },

        validate (rel, content) {
            return validateContent(safeRelative(rel), content, { Handlebars });
        },

        /** Save into the override. Saving content identical to the original removes the override. */
        save (siteName, rel, content) {
            const s = fileState(siteName, rel);

            if (!EDITABLE.test(s.safe)) throw new Error('This file type cannot be edited.');

            const check = validateContent(s.safe, content, { Handlebars });

            if (check.errors.length) {
                return { ok: false, ...check };
            }

            const text = String(content);

            if (s.original !== null && text === s.original) {
                if (s.override !== null) {
                    fs.unlinkSync(s.overridePath);
                    removeEmptyDirs(path.dirname(s.overridePath), s.d.overrideDir);
                }

                return { ok: true, overridden: false, ...check };
            }

            fs.mkdirSync(path.dirname(s.overridePath), { recursive: true });
            fs.writeFileSync(s.overridePath, text, 'utf8');
            return { ok: true, overridden: true, ...check };
        },

        /** Delete the override (for files that exist only in the override this deletes the file). */
        revert (siteName, rel) {
            const s = fileState(siteName, rel);

            if (s.override === null) return { ok: true, deleted: false };

            fs.unlinkSync(s.overridePath);
            removeEmptyDirs(path.dirname(s.overridePath), s.d.overrideDir);
            return { ok: true, deleted: s.original === null };
        },

        /** New file in the override (e.g. a new partial or asset). */
        create (siteName, rel) {
            const s = fileState(siteName, rel);

            if (!EDITABLE.test(s.safe)) throw new Error('Use one of: .hbs .html .css .js .json .txt .md .xml .svg');
            if (s.original !== null || s.override !== null) throw new Error('The file already exists.');

            fs.mkdirSync(path.dirname(s.overridePath), { recursive: true });
            fs.writeFileSync(s.overridePath, '', 'utf8');
            return { ok: true, path: s.safe };
        },

        /** Unified diff of one file, or of all overridden files when rel is empty. */
        diff (siteName, rel) {
            if (rel) {
                const s = fileState(siteName, rel);
                return s.override === null ? '' : diffFor(s.safe, s.original, s.override);
            }

            const d = dirs(siteName);
            const parts = [];

            for (const file of walk(d.overrideDir).sort()) {
                const original = readIf(within(d.themeDir, file));
                const override = readIf(within(d.overrideDir, file));
                const text = diffFor(file, original, override);

                if (text) parts.push(text);
            }

            return parts.join('');
        },

        async exportDiff (siteName) {
            const d = dirs(siteName);
            const text = service.diff(siteName, '');

            if (!text) return { ok: false, message: 'The theme has no changes.' };

            const stamp = new Date().toISOString().slice(0, 10);
            const result = await showSaveDialog({
                title: 'Export theme changes',
                defaultPath: `${d.theme}-changes-${stamp}.diff`,
                filters: [{ name: 'Diff', extensions: ['diff', 'patch'] }]
            });

            if (!result || result.canceled || !result.filePath) return { ok: false, canceled: true };

            fs.writeFileSync(result.filePath, text, 'utf8');
            return { ok: true, filePath: result.filePath, files: (text.match(/^\+\+\+ /gm) || []).length };
        }
    };

    return service;
}

module.exports = {
    id: 'theme-editor',
    name: 'Theme editor',
    createService,
    validateContent,
    safeRelative,

    register (ctx) {
        let dialog = null;

        if (process.versions.electron) {
            try { dialog = require('electron').dialog; } catch (e) { /* not available */ }
        }

        const service = createService({
            getSitesDir: () => ctx.appInstance && ctx.appInstance.sitesDir,
            showSaveDialog: options => (dialog ? dialog.showSaveDialog(options) : Promise.resolve({ canceled: true }))
        });

        ctx.handle('list', (event, siteName) => service.list(siteName));
        ctx.handle('read', (event, siteName, rel) => service.read(siteName, rel));
        ctx.handle('validate', (event, rel, content) => service.validate(rel, content));
        ctx.handle('save', (event, siteName, rel, content) => service.save(siteName, rel, content));
        ctx.handle('revert', (event, siteName, rel) => service.revert(siteName, rel));
        ctx.handle('create', (event, siteName, rel) => service.create(siteName, rel));
        ctx.handle('diff', (event, siteName, rel) => service.diff(siteName, rel));
        ctx.handle('export-diff', (event, siteName) => service.exportDiff(siteName));
    }
};
