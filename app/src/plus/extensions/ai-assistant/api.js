/**
 * Renderer-side helpers for the ai-assistant extension.
 */
export const EXTENSION_ID = 'ai-assistant';

/** "Error invoking remote method 'plus:x': Error: HTTP 401…" -> "HTTP 401…" */
export function cleanError (error) {
    const message = error && error.message ? error.message : String(error || 'Unknown error');
    return message.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(Provider)?(Http)?Error:\s*/, '');
}

export function call (vm, method, ...args) {
    return vm.$plus.invoke(EXTENSION_ID, method, ...args).catch(error => {
        throw new Error(cleanError(error));
    });
}

let counter = 0;

export function newRequestId () {
    counter += 1;
    return `req-${Date.now()}-${counter}`;
}

/** "Name: value" lines <-> headers object */
export function headersToText (headers) {
    return Object.entries(headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
}

export function textToHeaders (text) {
    const headers = {};

    for (const line of String(text || '').split(/\r?\n/)) {
        const index = line.indexOf(':');

        if (index > 0) {
            headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
        }
    }

    return headers;
}
