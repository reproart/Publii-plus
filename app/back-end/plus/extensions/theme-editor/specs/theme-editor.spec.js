const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createService, validateContent, safeRelative } = require('../index');
const { createUnifiedDiff } = require('../../../lib/unified-diff');

/** Minimal unified-diff applier for round-trip tests. */
function applyPatch (original, patch) {
    const src = original === null ? [] : original.replace(/\n$/, '').split('\n').filter((l, i, a) => !(a.length === 1 && l === ''));
    const out = [];
    let pos = 0;
    const lines = patch.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^@@ -(\d+),?(\d*) \+\d+,?\d* @@/);

        if (!m) continue;

        const start = Math.max(0, Number(m[1]) - (Number(m[2] === '' ? 1 : m[2]) ? 1 : 0));

        while (pos < start) out.push(src[pos++]);

        for (i++; i < lines.length && /^[ +-]/.test(lines[i]); i++) {
            const t = lines[i][0];
            const text = lines[i].slice(1);

            if (t === ' ') { out.push(src[pos++]); }
            if (t === '-') { pos++; }
            if (t === '+') { out.push(text); }
        }

        i--;
    }

    while (pos < src.length) out.push(src[pos++]);
    return out.length ? out.join('\n') + '\n' : '';
}

function makeSite () {
    const sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plus-theme-'));
    const site = path.join(sitesDir, 'blog');
    const theme = path.join(site, 'input', 'themes', 'simple');

    fs.mkdirSync(path.join(site, 'input', 'config'), { recursive: true });
    fs.writeFileSync(path.join(site, 'input', 'config', 'site.config.json'), JSON.stringify({ name: 'blog', theme: 'simple' }));

    const files = {
        'index.hbs': '{{> head}}\n<main>{{#each posts}}{{title}}{{/each}}</main>\n',
        'partials/footer.hbs': '<footer>\n  <p>Copyright</p>\n</footer>\n',
        'config.json': '{ "name": "Simple", "version": "1.0", "author": "x" }\n',
        'assets/css/style.css': 'body { color: red; }\n',
        'assets/js/scripts.js': 'var a = 1;\n',
        'assets/images/logo.png': 'binary',
        'assets/dynamic/fonts/inter/OFL.txt': 'license'
    };

    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(theme, rel)), { recursive: true });
        fs.writeFileSync(path.join(theme, rel), content);
    }

    const service = createService({ getSitesDir: () => sitesDir, showSaveDialog: async opts => ({ filePath: path.join(sitesDir, opts.defaultPath) }) });
    return { sitesDir, site, theme, override: theme + '-override', service };
}

describe('Publii Plus: unified diff', () => {
    it('round-trips changes, additions at both ends and new/empty files', () => {
        const cases = [
            ['a\nb\nc\n', 'a\nB\nc\n'],
            ['a\nb\nc\n', 'x\na\nb\nc\ny\n'],
            ['1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n', '1\n2\nX\n4\n5\n6\n7\n8\n9\n10\nY\n12\n'],
            ['a\n', '']
        ];

        for (const [a, b] of cases) {
            const patch = createUnifiedDiff(a, b, { oldName: 'a/f', newName: 'b/f' });
            assert.equal(applyPatch(a, patch), b, JSON.stringify([a, b, patch]));
        }

        assert.equal(createUnifiedDiff('same\n', 'same\n'), '');
        assert.match(createUnifiedDiff(null, 'new\n', { newName: 'b/n' }), /^--- \/dev\/null\n\+\+\+ b\/n\n@@ -0,0 \+1,1 @@\n\+new\n$/);
    });
});

describe('Publii Plus: theme editor', () => {
    it('lists editable theme files and marks overrides', () => {
        const { override, service } = makeSite();
        fs.mkdirSync(path.join(override, 'partials'), { recursive: true });
        fs.writeFileSync(path.join(override, 'partials', 'footer.hbs'), '<footer>changed</footer>\n');
        fs.writeFileSync(path.join(override, 'partials', 'extra.hbs'), 'new\n');

        const out = service.list('blog');
        assert.equal(out.theme, 'simple');
        assert.deepEqual(out.files.map(f => [f.path, f.overridden, f.onlyInOverride]), [
            ['assets/css/style.css', false, false],
            ['assets/js/scripts.js', false, false],
            ['config.json', false, false],
            ['index.hbs', false, false],
            ['partials/extra.hbs', true, true],
            ['partials/footer.hbs', true, false]
        ]);
    });

    it('saves into the override and never touches the theme copy', () => {
        const { theme, override, service } = makeSite();
        const before = fs.readFileSync(path.join(theme, 'partials/footer.hbs'), 'utf8');

        const res = service.save('blog', 'partials/footer.hbs', '<footer>{{@website.name}}</footer>\n');
        assert.equal(res.ok, true);
        assert.equal(res.overridden, true);
        assert.equal(fs.readFileSync(path.join(override, 'partials/footer.hbs'), 'utf8'), '<footer>{{@website.name}}</footer>\n');
        assert.equal(fs.readFileSync(path.join(theme, 'partials/footer.hbs'), 'utf8'), before);

        const read = service.read('blog', 'partials/footer.hbs');
        assert.equal(read.content, '<footer>{{@website.name}}</footer>\n');
        assert.equal(read.original, before);

        // saving the original content again removes the override (and empty folders)
        const back = service.save('blog', 'partials/footer.hbs', before);
        assert.equal(back.overridden, false);
        assert.equal(fs.existsSync(override), false);
    });

    it('blocks saving files with syntax errors', () => {
        const { override, service } = makeSite();

        const hbs = service.save('blog', 'index.hbs', '{{#each posts}}\n<p>{{title}}</p>\n');
        assert.equal(hbs.ok, false);
        assert.match(hbs.errors[0].message, /Parse error|Expecting|each/);

        const json = service.save('blog', 'config.json', '{ "name": "Simple", }');
        assert.equal(json.ok, false);
        assert.equal(json.errors[0].line, 1);

        const js = service.save('blog', 'assets/js/scripts.js', 'var a = ;\n');
        assert.equal(js.ok, false);

        assert.equal(fs.existsSync(override), false, 'nothing written');

        const css = service.save('blog', 'assets/css/style.css', 'body { color: blue;\n');
        assert.equal(css.ok, true, 'CSS problems are warnings only');
        assert.match(css.warnings[0].message, /Unbalanced braces/);
    });

    it('validates ES modules without blocking', () => {
        const res = validateContent('assets/js/app.js', 'import x from "./x.js";\nexport default x;\n');
        assert.deepEqual(res.errors, []);
        assert.match(res.warnings[0].message, /Not checked as an ES module/);
    });

    it('reverts overrides, creates new files and refuses unsafe paths', () => {
        const { override, service } = makeSite();

        service.save('blog', 'assets/css/style.css', 'body { color: blue; }\n');
        assert.deepEqual(service.revert('blog', 'assets/css/style.css'), { ok: true, deleted: false });
        assert.equal(service.read('blog', 'assets/css/style.css').override, null);

        assert.equal(service.create('blog', 'partials/banner.hbs').ok, true);
        assert.ok(fs.existsSync(path.join(override, 'partials/banner.hbs')));
        assert.throws(() => service.create('blog', 'partials/banner.hbs'), /already exists/);
        assert.throws(() => service.create('blog', 'partials/run.exe'), /Use one of/);
        assert.deepEqual(service.revert('blog', 'partials/banner.hbs'), { ok: true, deleted: true });

        for (const bad of ['../../../etc/passwd', '/etc/passwd', 'partials/../../x.hbs', '']) {
            assert.throws(() => service.read('blog', bad), /Invalid file path|File not found/);
        }

        assert.throws(() => service.list('../blog'), /Invalid website/);
        assert.equal(safeRelative('\\partials\\footer.hbs'), 'partials/footer.hbs');
    });

    it('exports one diff for all overridden files that applies to the theme', async () => {
        const { sitesDir, theme, service } = makeSite();

        service.save('blog', 'partials/footer.hbs', '<footer>\n  <p>Copyright {{@website.name}}</p>\n</footer>\n');
        service.save('blog', 'assets/css/style.css', 'body { color: blue; }\n');
        service.create('blog', 'partials/banner.hbs');
        service.save('blog', 'partials/banner.hbs', '<div class="banner"></div>\n');

        const one = service.diff('blog', 'partials/footer.hbs');
        assert.match(one, /^--- a\/partials\/footer\.hbs\n\+\+\+ b\/partials\/footer\.hbs\n/);
        assert.match(one, /-  <p>Copyright<\/p>\n\+  <p>Copyright \{\{@website\.name\}\}<\/p>/);

        const all = service.diff('blog', '');
        assert.equal((all.match(/^\+\+\+ /gm) || []).length, 3);
        assert.match(all, /--- \/dev\/null\n\+\+\+ b\/partials\/banner\.hbs/);

        // each file's diff applies to the original theme file
        const footerPatch = all.slice(all.indexOf('--- a/partials/footer.hbs'), all.indexOf('--- a/partials/footer.hbs') + one.length);
        assert.equal(applyPatch(fs.readFileSync(path.join(theme, 'partials/footer.hbs'), 'utf8'), footerPatch), '<footer>\n  <p>Copyright {{@website.name}}</p>\n</footer>\n');

        const exported = await service.exportDiff('blog');
        assert.equal(exported.ok, true);
        assert.equal(exported.files, 3);
        assert.equal(fs.readFileSync(exported.filePath, 'utf8'), all);
        assert.match(path.basename(exported.filePath), /^simple-changes-\d{4}-\d{2}-\d{2}\.diff$/);
        assert.ok(exported.filePath.startsWith(sitesDir));
    });
});
