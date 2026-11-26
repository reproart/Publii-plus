/**
 * Site check – external links: HEAD (GET when HEAD is not allowed), a few requests at a time and at most two per
 * host, a timeout per request, results cached (working links for 7 days). Sites that refuse robots
 * (403/429/999, social networks) are reported as "not verified", not as broken.
 */

const OK_TTL = 7 * 24 * 3600 * 1000;
const BAD_TTL = 0;
const UA = 'Mozilla/5.0 (compatible; PubliiPlus-LinkCheck/1.0; +https://getpublii.com)';

/** Hosts that block automated requests – never checked */
const SKIP_HOSTS = ['linkedin.com', 'instagram.com', 'facebook.com', 'fb.com', 'x.com', 'twitter.com', 'tiktok.com', 'vk.com', 'ok.ru'];

function hostOf (url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch (e) {
        return '';
    }
}

const skipped = host => SKIP_HOSTS.some(h => host === h || host.endsWith('.' + h));

/**
 * Classify one answer.
 * @returns {{ state: 'ok'|'broken'|'error'|'unverified'|'redirect', status, detail, finalUrl? }}
 */
function classify (status, finalUrl, url) {
    if (status >= 200 && status < 300) {
        if (finalUrl && finalUrl !== url && hostOf(finalUrl) !== hostOf(url)) {
            return { state: 'redirect', status, detail: 'Redirects to another website', finalUrl };
        }

        return { state: 'ok', status };
    }

    if (status === 404 || status === 410) return { state: 'broken', status, detail: status === 404 ? 'Not found (404)' : 'Gone (410)' };
    if (status === 401 || status === 403 || status === 429 || status === 999 || status === 451) return { state: 'unverified', status, detail: `The website refused the check (${status})` };
    if (status >= 500) return { state: 'error', status, detail: `Server error (${status})` };

    return { state: 'error', status, detail: `HTTP ${status}` };
}

async function request (fetchImpl, url, method, timeoutMs, outerSignal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();

    if (outerSignal) outerSignal.addEventListener('abort', onAbort);

    try {
        const res = await fetchImpl(url, { method, redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': UA, Accept: '*/*' } });

        if (method === 'GET' && res.body && res.body.cancel) res.body.cancel().catch(() => {});

        return { status: res.status, finalUrl: res.url || url };
    } finally {
        clearTimeout(timer);
        if (outerSignal) outerSignal.removeEventListener('abort', onAbort);
    }
}

async function checkOne (fetchImpl, url, timeoutMs, signal) {
    try {
        let res = await request(fetchImpl, url, 'HEAD', timeoutMs, signal);

        // many servers do not implement HEAD properly
        if ([400, 403, 404, 405, 406, 501, 503].includes(res.status)) res = await request(fetchImpl, url, 'GET', timeoutMs, signal);

        return classify(res.status, res.finalUrl, url);
    } catch (e) {
        if (signal && signal.aborted) throw e;

        const code = (e.cause && (e.cause.code || e.cause.errno)) || e.code || '';

        if (e.name === 'AbortError') return { state: 'error', status: 0, detail: `No answer in ${Math.round(timeoutMs / 1000)} s` };
        if (/ENOTFOUND|EAI_AGAIN/.test(code)) return { state: 'broken', status: 0, detail: 'The domain does not exist' };
        if (/CERT|SSL|TLS/i.test(code + ' ' + e.message)) return { state: 'error', status: 0, detail: 'Certificate problem' };
        return { state: 'error', status: 0, detail: 'Connection failed' + (code ? ` (${code})` : '') };
    }
}

/**
 * @param {string[]} urls
 * @param {object} o
 * @param {object} [o.cache]       { [url]: { state, status, detail, at } } – updated in place
 * @param {function} [o.onProgress] (done, total)
 * @returns {Promise<Map<string, object>>} url → result
 */
async function checkExternal (urls, { fetchImpl = fetch, cache = {}, concurrency = 8, perHost = 2, timeoutMs = 12000, now = () => Date.now(), onProgress = () => {}, signal } = {}) {
    const results = new Map();
    const queue = [];

    for (const url of urls) {
        const host = hostOf(url);
        const cached = cache[url];

        if (skipped(host)) {
            results.set(url, { state: 'skipped', status: 0, detail: 'Not checked: the website blocks automated checks' });
        } else if (cached && now() - cached.at < (cached.state === 'ok' ? OK_TTL : BAD_TTL)) {
            results.set(url, { ...cached, cached: true });
        } else {
            queue.push(url);
        }
    }

    const total = urls.length;
    const active = new Map();
    let done = results.size;

    onProgress(done, total);

    await new Promise((resolve, reject) => {
        let running = 0;

        const next = () => {
            if (signal && signal.aborted) return reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
            if (!queue.length && running === 0) return resolve();

            while (running < concurrency && queue.length) {
                // take the next URL whose host is not busy
                let pick = -1;

                for (let i = 0; i < queue.length; i++) {
                    if ((active.get(hostOf(queue[i])) || 0) < perHost) {
                        pick = i;
                        break;
                    }
                }

                if (pick === -1) break;

                const [url] = queue.splice(pick, 1);
                const host = hostOf(url);

                active.set(host, (active.get(host) || 0) + 1);
                running++;

                checkOne(fetchImpl, url, timeoutMs, signal).then(result => {
                    results.set(url, result);
                    cache[url] = { state: result.state, status: result.status, detail: result.detail || '', finalUrl: result.finalUrl, at: now() };
                }, error => {
                    if (signal && signal.aborted) return;
                    results.set(url, { state: 'error', status: 0, detail: error.message });
                }).finally(() => {
                    running--;
                    active.set(host, active.get(host) - 1);
                    onProgress(++done, total);
                    next();
                });
            }
        };

        next();
    });

    return results;
}

module.exports = { checkExternal, classify, SKIP_HOSTS };
