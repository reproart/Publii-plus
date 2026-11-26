const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyze } = require('../checks');
const { checkExternal, classify } = require('../external');
const siteCheck = require('../index');

const page = ({ title = 'Page', description = 'A description', h1 = '<h1>Heading</h1>', robots = '', canonical = '', lang = 'en', body = '' } = {}) =>
    `<!doctype html><html${lang ? ` lang="${lang}"` : ''}><head><title>${title}</title>` +
    (description ? `<meta name="description" content="${description}">` : '') +
    (robots ? `<meta name="robots" content="${robots}">` : '') +
    (canonical ? `<link rel="canonical" href="${canonical}">` : '') +
    '<link rel="stylesheet" href="https://example.com/blog/assets/css/style.css"><link rel="preconnect" href="https://fonts.example.org">' +
    `</head><body>${h1}${body}<script src="/blog/assets/js/app.js"></script></body></html>`;

function site (files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-check-'));

    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }

    return dir;
}

const baseFiles = () => ({
    'assets/css/style.css': 'body{}',
    'assets/js/app.js': '',
    'media/posts/1/photo.jpg': Buffer.alloc(10),
    'media/posts/1/big.jpg': Buffer.alloc(700 * 1024),
    'robots.txt': 'User-agent: *\nDisallow:\n'
});

const items = siteCheck.itemIndex([
    { id: 1, slug: 'first-post', title: 'First post', status: 'published', editor: 'markdown' },
    { id: 2, slug: 'second-post', title: 'Second', status: 'published,hidden' },
    { id: 3, slug: 'about', title: 'About', status: 'published,is-page', editor: 'blockeditor' },
    { id: 4, slug: 'draft', title: 'Draft', status: 'draft' }
]);

const byCheck = (issues, check) => issues.filter(i => i.check === check);

describe('Publii Plus: site check – analysis', () => {
    it('finds broken internal links, missing files and anchors; good links pass', () => {
        const dir = site({
            ...baseFiles(),
            'index.html': page({ title: 'Home', body: '<a href="first-post/">ok</a> <a href="https://example.com/blog/about.html#team">anchor ok</a> <a href="about.html#nope">bad anchor</a> <a href="gone/">Gone post</a> <a href="#INTERNAL_LINK#/post/9">deleted</a> <a href="mailto:a@b.c">mail</a> <a href="#top">top</a>' }),
            'first-post/index.html': page({ title: 'First post', body: '<img src="../media/posts/1/photo.jpg" alt="Photo"><img src="../media/posts/1/missing.png" alt="x"><a href="/blog/first-post/#sec">self</a><h2 id="sec">S</h2>' }),
            'about.html': page({ title: 'About', body: '<section id="team"></section>' })
        });
        const { issues, pages } = analyze({ outputDir: dir, domain: 'https://example.com/blog', itemFor: items });

        assert.equal(pages, 3);
        const broken = byCheck(issues, 'broken-link').map(i => `${i.page} → ${i.target}`);
        assert.deepEqual(broken.sort(), ['index.html → #INTERNAL_LINK#/post/9', 'index.html → /blog/gone/']);
        assert.deepEqual(byCheck(issues, 'missing-file').map(i => i.target), ['/blog/media/posts/1/missing.png']);
        assert.deepEqual(byCheck(issues, 'missing-anchor').map(i => i.target), ['/blog/about.html#nope']);
        assert.equal(byCheck(issues, 'broken-link').find(i => i.target === '/blog/gone/').text, 'Gone post', 'link text in the report');
        assert.deepEqual(byCheck(issues, 'missing-file')[0].item, { type: 'post', id: 1, title: 'First post', editor: 'markdown' }, 'edit link for the post');
    });

    it('images: missing alt (decorative alt="" is fine), heavy files; heavy pages', () => {
        const dir = site({
            ...baseFiles(),
            'index.html': page({ body: '<img src="media/posts/1/photo.jpg"><img src="media/posts/1/photo.jpg" alt=""><img src="media/posts/1/photo.jpg" aria-hidden="true"><img src="media/posts/1/big.jpg" alt="Big" srcset="media/posts/1/photo.jpg 300w, media/posts/1/big.jpg 1200w">' })
        });
        const { issues } = analyze({ outputDir: dir, domain: 'https://example.com/blog' });

        assert.deepEqual(byCheck(issues, 'image-alt').map(i => i.target), ['media/posts/1/photo.jpg']);
        const heavy = byCheck(issues, 'image-heavy');
        assert.equal(heavy.length, 1);
        assert.equal(heavy[0].target, 'media/posts/1/big.jpg');
        assert.match(heavy[0].detail, /700 KB/);
        assert.equal(byCheck(issues, 'page-heavy').length, 0);

        const big = Buffer.alloc(1200 * 1024);
        const dir2 = site({ ...baseFiles(), 'a.jpg': big, 'b.jpg': big, 'c.jpg': big, 'index.html': page({ body: '<img src="a.jpg" alt="a"><img src="b.jpg" alt="b"><img src="c.jpg" alt="c">' }) });
        assert.match(byCheck(analyze({ outputDir: dir2, domain: 'https://example.com/blog' }).issues, 'page-heavy')[0].detail, /3\.\d MB/);
    });

    it('SEO: titles, descriptions, H1, canonical, lang; service and pagination pages are skipped', () => {
        const dir = site({
            ...baseFiles(),
            'index.html': page({ title: 'Same', lang: '' }),
            'first-post/index.html': page({ title: 'Same', description: '', h1: '' }),
            'about.html': page({ title: 'A'.repeat(80), h1: '<h1>a</h1><h1>b</h1>', canonical: 'https://other.example/about' }),
            'tags/x/index.html': page({ title: 'Same', canonical: 'https://example.com/blog/tags/missing/' }),
            'page/2/index.html': page({ title: 'Same' }),
            '404.html': page({ title: '', h1: '' }),
            'search.html': page({ title: 'Same' })
        });
        const { issues } = analyze({ outputDir: dir, domain: 'https://example.com/blog', itemFor: items });

        assert.deepEqual(byCheck(issues, 'title-duplicate').map(i => i.page).sort(), ['first-post/index.html', 'index.html', 'tags/x/index.html']);
        assert.deepEqual(byCheck(issues, 'title-long').map(i => i.page), ['about.html']);
        assert.deepEqual(byCheck(issues, 'description-missing').map(i => i.page), ['first-post/index.html'], 'only posts and pages');
        assert.deepEqual(byCheck(issues, 'h1-missing').map(i => i.page), ['first-post/index.html']);
        assert.deepEqual(byCheck(issues, 'h1-multiple').map(i => i.page), ['about.html']);
        assert.deepEqual(byCheck(issues, 'canonical-external').map(i => i.page), ['about.html']);
        assert.deepEqual(byCheck(issues, 'canonical-broken').map(i => i.page), ['tags/x/index.html']);
        assert.match(byCheck(issues, 'lang-missing')[0].detail, /^1 page/);
        assert.equal(byCheck(issues, 'title-missing').length, 0, '404 page is not checked');
        assert.equal(issues[0].severity, 'error', 'errors first');
    });

    it('indexing: whole site, homepage, single posts, robots.txt', () => {
        const files = {
            ...baseFiles(),
            'index.html': page({ robots: 'noindex, follow' }),
            'first-post/index.html': page({ robots: 'noindex' }),
            'robots.txt': 'User-agent: Googlebot\nDisallow: /private\n\nUser-agent: *\nDisallow: /\n'
        };
        const { issues } = analyze({ outputDir: site(files), domain: 'https://example.com/blog', itemFor: items });

        assert.ok(byCheck(issues, 'noindex-home').length === 1);
        assert.deepEqual(byCheck(issues, 'noindex-page').map(i => i.page), ['first-post/index.html']);
        assert.equal(byCheck(issues, 'robots-blocked').length, 1);

        const whole = analyze({ outputDir: site(files), domain: 'https://example.com/blog', siteNoIndex: true, itemFor: items }).issues;
        assert.equal(byCheck(whole, 'noindex-site').length, 1);
        assert.equal(byCheck(whole, 'noindex-home').length + byCheck(whole, 'robots-blocked').length, 0, 'intended: one message only');
    });

    it('external links and mixed content are collected; relative-URL sites work', () => {
        const dir = site({
            ...baseFiles(),
            'index.html': page({ body: '<a href="https://ext.example.org/a">A</a><a href="http://ext.example.org/a#x">again</a><img src="http://cdn.example.net/i.png" alt="i"><iframe src="https://www.youtube.com/embed/1"></iframe><a href="https://example.com/blog/about.html">abs internal</a>' }),
            'about.html': page({})
        });
        const r = analyze({ outputDir: dir, domain: 'https://example.com/blog' });

        assert.deepEqual([...r.external.keys()].sort(), ['http://cdn.example.net/i.png', 'http://ext.example.org/a', 'https://ext.example.org/a', 'https://www.youtube.com/embed/1']);
        assert.deepEqual(byCheck(r.issues, 'mixed-content').map(i => i.target), ['http://cdn.example.net/i.png']);
        assert.equal(byCheck(r.issues, 'broken-link').length, 0);

        const relative = site({ ...baseFiles(), 'index.html': '<html lang="en"><head><title>T</title></head><body><h1>x</h1><a href="./sub/">ok</a><a href="./nope/">bad</a></body></html>', 'sub/index.html': page({}) });
        const rr = analyze({ outputDir: relative, domain: '#PUBLII_RELATIVE_URL_BASE#' });
        assert.deepEqual(byCheck(rr.issues, 'broken-link').map(i => i.target), ['/nope/']);
    });
});

describe('Publii Plus: site check – external links', () => {
    it('classifies answers', () => {
        assert.equal(classify(200, 'https://a.org/x', 'https://a.org/x').state, 'ok');
        assert.equal(classify(200, 'https://b.org/', 'https://a.org/x').state, 'redirect');
        assert.equal(classify(404).state, 'broken');
        assert.equal(classify(410).state, 'broken');
        assert.equal(classify(403).state, 'unverified');
        assert.equal(classify(429).state, 'unverified');
        assert.equal(classify(503).state, 'error');
    });

    it('HEAD then GET, per-host limit, cache, skipped hosts, DNS errors, timeouts', async () => {
        const calls = [];
        const activePerHost = {};
        let maxPerHost = 0;
        const fetchImpl = async (url, opts) => {
            const host = new URL(url).hostname;
            activePerHost[host] = (activePerHost[host] || 0) + 1;
            maxPerHost = Math.max(maxPerHost, activePerHost[host]);
            calls.push(opts.method + ' ' + url);
            await new Promise(r => setTimeout(r, 5));
            activePerHost[host]--;

            if (url.includes('nodns')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
            if (url.includes('slow')) return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
            if (url.includes('nohead') && opts.method === 'HEAD') return { status: 405, url };
            if (url.includes('missing')) return { status: 404, url };
            return { status: 200, url, body: { cancel: async () => {} } };
        };
        const urls = ['https://a.org/1', 'https://a.org/2', 'https://a.org/3', 'https://a.org/4', 'https://b.org/nohead', 'https://b.org/missing', 'https://nodns.invalid/', 'https://slow.org/', 'https://www.linkedin.com/in/x'];
        const cache = {};
        const progress = [];
        const res = await checkExternal(urls, { fetchImpl, cache, timeoutMs: 50, onProgress: (d, t) => progress.push(`${d}/${t}`) });

        assert.equal(res.get('https://a.org/1').state, 'ok');
        assert.equal(res.get('https://b.org/nohead').state, 'ok');
        assert.ok(calls.includes('GET https://b.org/nohead'), 'GET after 405 on HEAD');
        assert.equal(res.get('https://b.org/missing').state, 'broken');
        assert.equal(res.get('https://nodns.invalid/').detail, 'The domain does not exist');
        assert.equal(res.get('https://slow.org/').detail, 'No answer in 0 s');
        assert.equal(res.get('https://www.linkedin.com/in/x').state, 'skipped');
        assert.ok(maxPerHost <= 2, 'at most two requests per host');
        assert.equal(progress[progress.length - 1], '9/9');

        calls.length = 0;
        const again = await checkExternal(['https://a.org/1', 'https://b.org/missing'], { fetchImpl, cache, timeoutMs: 50 });
        assert.equal(again.get('https://a.org/1').cached, true, 'working links come from the cache');
        assert.deepEqual(calls, ['HEAD https://b.org/missing', 'GET https://b.org/missing'], 'broken links are checked again');
    });
});

describe('Publii Plus: site check – service', () => {
    it('renders, analyzes, checks external links, stores the report and a summary', async () => {
        const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-check-app-'));
        const out = site({ ...baseFiles(), 'index.html': page({ body: '<a href="https://ext.example.org/missing">ext</a><a href="first-post/">p</a>' }), 'first-post/index.html': page({ title: 'P' }) });
        let rendered = 0;
        let clock = 5000;
        const service = siteCheck.createService({
            appDir,
            siteConfig: () => ({ domain: 'https://example.com/blog', advanced: {} }),
            outputDir: () => out,
            render: async () => { rendered++; },
            items: () => [{ id: 1, slug: 'first-post', title: 'P', status: 'published', editor: 'tinymce' }],
            fetchImpl: async url => ({ status: url.includes('missing') ? 404 : 200, url }),
            now: () => (clock += 10)
        });

        const report = await service.run('blog');
        assert.equal(rendered, 1);
        assert.equal(report.pages, 2);
        assert.deepEqual(report.external, { total: 1, checked: true, broken: 1 });
        assert.equal(report.issues[0].check, 'external-broken');
        assert.equal(report.issues[0].page, 'index.html');
        assert.deepEqual(service.summary('blog').counts, report.counts);
        assert.equal(service.report('blog').issues.length, report.issues.length);
        assert.equal(service.progress('blog').running, false);

        const quick = await service.run('blog', { rerender: false, external: false });
        assert.equal(rendered, 1, 'no render');
        assert.equal(quick.external.checked, false);
        assert.throws(() => service.report('../x'), /Invalid website/);
    });

    it('refuses a second run and reports a website that was never rendered', async () => {
        const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-check-app-'));
        let release;
        const service = siteCheck.createService({
            appDir,
            siteConfig: () => ({ domain: '' }),
            outputDir: () => path.join(appDir, 'nothing'),
            render: () => new Promise(r => { release = r; })
        });

        const first = service.run('blog');
        await new Promise(r => setTimeout(r, 5));
        assert.equal(service.progress('blog').phase, 'render');
        await assert.rejects(service.run('blog'), /already being checked/);
        release();
        await assert.rejects(first, /has not been rendered yet/);
    });
});
