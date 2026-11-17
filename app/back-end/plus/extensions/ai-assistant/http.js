/**
 * Minimal JSON HTTP client for AI providers (http and https).
 * Uses Electron's net.fetch when available (system proxy settings), otherwise global fetch.
 */

function defaultFetch () {
    if (!process.versions.electron) {
        return globalThis.fetch;
    }

    try {
        const { net } = require('electron');

        if (net && typeof net.fetch === 'function') {
            return net.fetch.bind(net);
        }
    } catch (e) {
        // not running inside Electron (tests)
    }

    return globalThis.fetch;
}

class ProviderHttpError extends Error {
    constructor (message, { status = 0, body = '' } = {}) {
        super(message);
        this.name = 'ProviderHttpError';
        this.status = status;
        this.body = body;
    }
}

/** Short human readable message from a provider error response. */
function describeError (status, bodyText) {
    let detail = '';

    try {
        const body = JSON.parse(bodyText);
        detail = (body.error && (body.error.message || body.error.type || (typeof body.error === 'string' ? body.error : ''))) || body.message || body.detail || '';
    } catch (e) {
        detail = String(bodyText || '').replace(/\s+/g, ' ').slice(0, 200);
    }

    const hints = {
        401: 'Check the API key.',
        403: 'The key has no access to this model or endpoint.',
        404: 'Check the base URL and the model name.',
        429: 'Rate limit or quota exceeded – try again later.'
    };

    return `HTTP ${status}${detail ? ': ' + detail : ''}${hints[status] ? ' ' + hints[status] : ''}`;
}

/**
 * @param {object} options { url, method, headers, body, timeoutMs, signal, fetchImpl }
 * @returns parsed JSON body
 */
async function requestJson ({ url, method = 'POST', headers = {}, body, timeoutMs = 120000, signal, fetchImpl }) {
    let parsedUrl;

    try {
        parsedUrl = new URL(url);
    } catch (e) {
        throw new ProviderHttpError(`Invalid URL: ${url}`);
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new ProviderHttpError('Only http:// and https:// URLs are supported.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onAbort = () => controller.abort(new Error('cancelled'));

    if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }

    let response;
    let text;

    try {
        response = await (fetchImpl || defaultFetch())(parsedUrl.toString(), {
            method,
            headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: controller.signal
        });
        text = await response.text();
    } catch (e) {
        const reason = controller.signal.reason && controller.signal.reason.message;

        if (reason === 'timeout') throw new ProviderHttpError(`The provider did not answer within ${Math.round(timeoutMs / 1000)} s.`);
        if (reason === 'cancelled') throw new ProviderHttpError('Cancelled.');

        throw new ProviderHttpError(`Cannot connect to ${parsedUrl.host}: ${e.cause && e.cause.code ? e.cause.code : e.message}`);
    } finally {
        clearTimeout(timer);

        if (signal) signal.removeEventListener('abort', onAbort);
    }

    if (!response.ok) {
        throw new ProviderHttpError(describeError(response.status, text), { status: response.status, body: text });
    }

    try {
        return JSON.parse(text);
    } catch (e) {
        throw new ProviderHttpError('The provider returned a non-JSON response.', { status: response.status, body: text });
    }
}

/** True when an http:// URL points to a non-local host (the API key would travel unencrypted). */
function isInsecureRemote (url) {
    try {
        const u = new URL(url);

        if (u.protocol !== 'http:') return false;

        const host = u.hostname.replace(/^\[|\]$/g, '');
        return !(host === 'localhost' || host === '::1' || /^127\./.test(host) || host.endsWith('.local') || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host));
    } catch (e) {
        return false;
    }
}

module.exports = { requestJson, ProviderHttpError, describeError, isInsecureRemote };
