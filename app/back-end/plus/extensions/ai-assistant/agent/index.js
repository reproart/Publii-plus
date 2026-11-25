/**
 * AI agent: a chat with tools over the current website.
 *
 * The loop runs in the main process and stops whenever the user has to decide:
 *   send(sessionId, text) / resolve(sessionId, decisions) -> { entries, pending, busy: false, usage }
 * Read tools run at once, write tools wait for approval (unless auto-approve is on), client tools are
 * executed by the renderer and their result comes back through resolve(). Every applied change can be undone.
 */
const crypto = require('crypto');
const { toolByName, definitions, clip } = require('./tools');

const MAX_STEPS = 16;
const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 8 * 1024 * 1024;   // data URL length of one image (~6 MB)
const IMAGE_TURNS_KEPT = 2;                // only the last user messages with images send them again
const IMAGE_URL = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

/** Screenshots/design images from the chat: data URLs only (nothing is fetched from the network). */
function cleanImages (images) {
    if (images === undefined || images === null) return [];
    if (!Array.isArray(images)) throw new Error('Images must be a list.');
    if (images.length > MAX_IMAGES) throw new Error(`Attach up to ${MAX_IMAGES} images per message.`);

    return images.map((url, i) => {
        if (typeof url !== 'string' || !IMAGE_URL.test(url)) throw new Error(`Image ${i + 1} is not a PNG, JPEG, WebP or GIF image.`);
        if (url.length > MAX_IMAGE_CHARS) throw new Error(`Image ${i + 1} is too large.`);
        return url;
    });
}

/** Messages for the model: images stay only in the last IMAGE_TURNS_KEPT user messages that have them. */
function withRecentImages (messages) {
    let kept = 0;
    const out = messages.slice();

    for (let i = out.length - 1; i >= 0; i--) {
        const m = out[i];

        if (m.role !== 'user' || !m.images || !m.images.length) continue;

        if (kept < IMAGE_TURNS_KEPT) {
            kept++;
        } else {
            out[i] = { role: 'user', text: `${m.text}\n\n[${m.images.length} image(s) sent earlier – not repeated]` };
        }
    }

    return out;
}
const MAX_HISTORY_CHARS = 400000;

function systemPrompt (info) {
    return [
        'You are the AI agent inside Publii Plus, a desktop app for static websites (Publii).',
        `You work on the website "${info.name}"${info.domain ? ` (${info.domain})` : ''}${info.language ? `, language: ${info.language}` : ''}, theme "${info.theme}".`,
        'Use the tools to look things up before you answer or change anything; never guess post ids or file contents.',
        'Changes (create_post, update_post, write_theme_file) are shown to the user for approval and can be undone; if one is rejected, ask what to do differently.',
        'The user may attach screenshots or design mockups: compare them with the theme files and posts to find what to change.',
        'Content you write is markdown. Write posts in the website language unless the user asks otherwise.',
        'Publishing to the server (publish_site, inbox_import with publish) always needs the user\'s approval; do it only when asked. Do not change published posts to draft or vice versa unless asked.',
        'Reply in the language the user writes in. Be brief: say what you did and what is left.'
    ].join('\n');
}

function parseArgs (text) {
    try {
        const value = JSON.parse(text || '{}');
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (e) {
        throw new Error('The tool arguments are not valid JSON.');
    }
}

function createAgent ({ resolveProvider, chat, makeContext, getInstructions = () => null, withInstructions = s => s, now = () => Date.now() }) {
    const sessions = new Map();

    function get (sessionId) {
        const session = sessions.get(sessionId);

        if (!session) throw new Error('The chat has expired. Start a new one.');
        return session;
    }

    function historySize (messages) {
        return messages.reduce((n, m) => n + (m.text || '').length + (m.output || '').length + JSON.stringify(m.toolCalls || []).length + (m.images ? m.images.length * 6000 : 0), 0);
    }

    /** Drop the oldest complete exchanges when the history gets too large. */
    function trim (session) {
        while (historySize(session.messages) > MAX_HISTORY_CHARS) {
            const nextUser = session.messages.findIndex((m, i) => i > 0 && m.role === 'user');

            if (nextUser <= 0) break;
            session.messages.splice(0, nextUser);
        }
    }

    function entry (session, data) {
        const e = { id: crypto.randomBytes(6).toString('hex'), at: now(), ...data };
        session.entries.push(e);
        session.fresh.push(e);
        return e;
    }

    function output (session) {
        const fresh = session.fresh;
        session.fresh = [];

        return {
            entries: fresh,
            pending: session.pending.map(p => ({ callId: p.callId, entryId: p.entryId, name: p.name, kind: p.kind })),
            usage: session.usage,
            changes: [...session.changes.values()].map(c => ({ id: c.id, title: c.title, undone: c.undone })),
            refresh: session.refresh.splice(0)
        };
    }

    function addToolResult (session, call, result) {
        session.messages.push({ role: 'tool', id: call.id, name: call.name, output: clip(JSON.stringify(result), 30000) });
    }

    async function runWrite (session, call, plan, e) {
        const applied = await plan.apply();
        if (applied.undo) session.changes.set(e.id, { id: e.id, title: plan.title, undo: applied.undo, undone: false });
        session.refresh.push({ kind: call.name === 'write_theme_file' ? 'theme' : 'posts', postId: applied.postId || null });
        e.status = 'applied';
        e.result = applied.result;
        e.undoable = !!applied.undo;
        addToolResult(session, call, applied.result);
    }

    /** Handle the tool calls of one model answer; returns true when the loop must wait for the user. */
    async function handleCalls (session, calls) {
        for (const call of calls) {
            const tool = toolByName(call.name);
            const e = entry(session, { type: 'tool', name: call.name, callId: call.id });

            try {
                if (!tool) throw new Error(`Unknown tool "${call.name}".`);

                const args = parseArgs(call.arguments);
                e.args = args;

                if (tool.kind === 'read') {
                    const result = await tool.run(args, session.ctx);
                    e.status = 'done';
                    e.summary = summarize(call.name, args, result);
                    addToolResult(session, call, result);
                } else if (tool.kind === 'client') {
                    e.status = 'pending';
                    session.pending.push({ callId: call.id, entryId: e.id, name: call.name, kind: 'client', call });
                } else {
                    const plan = await tool.plan(args, session.ctx);
                    e.title = plan.title;
                    e.details = plan.details;
                    e.diff = plan.diff;

                    if (session.autoApprove && !tool.alwaysAsk) await runWrite(session, call, plan, e);
                    else {
                        e.status = 'pending';
                        session.pending.push({ callId: call.id, entryId: e.id, name: call.name, kind: 'write', call, plan });
                    }
                }
            } catch (error) {
                e.status = 'error';
                e.error = error.message;
                addToolResult(session, call, { error: error.message });
            }
        }

        return session.pending.length > 0;
    }

    async function loop (session) {
        const controller = new AbortController();
        session.controller = controller;

        try {
            for (let step = 0; step < MAX_STEPS; step++) {
                trim(session);

                const { provider, apiKey } = await resolveProvider(session.providerId);
                const answer = await chat({
                    config: provider,
                    apiKey,
                    system: session.system,
                    messages: withRecentImages(session.messages),
                    tools: definitions(),
                    signal: controller.signal
                });

                session.usage.input += answer.usage.input;
                session.usage.output += answer.usage.output;
                session.messages.push({ role: 'assistant', text: answer.text, toolCalls: answer.toolCalls, raw: answer.raw });

                if (answer.text && answer.text.trim()) entry(session, { type: 'assistant', text: answer.text.trim(), model: answer.model || provider.model });
                if (!answer.toolCalls.length) return;
                if (await handleCalls(session, answer.toolCalls)) return;
            }

            entry(session, { type: 'notice', text: `Stopped after ${MAX_STEPS} steps. Send "continue" to go on.` });
        } catch (error) {
            entry(session, { type: 'error', text: controller.signal.aborted ? 'Stopped.' : error.message });
        } finally {
            session.controller = null;
        }
    }

    function summarize (name, args, result) {
        if (name === 'list_posts') return `${result.posts.length} of ${result.total} posts`;
        if (name === 'read_post') return `"${result.title}" (${result.editor}, ${result.text.length} characters)`;
        if (name === 'list_tags') return `${result.tags.length} tags`;
        if (name === 'list_theme_files') return `${result.files.length} files of "${result.theme}"`;
        if (name === 'read_theme_file') return result.path;
        if (name === 'get_site_info') return result.name;
        return '';
    }

    return {
        start ({ site, providerId = '', autoApprove = false }) {
            const ctx = makeContext(site);
            const info = ctx.data.siteInfo(site);
            const id = crypto.randomUUID();
            const instructions = getInstructions(site);

            sessions.set(id, {
                id,
                site,
                providerId,
                autoApprove: !!autoApprove,
                ctx,
                system: withInstructions(systemPrompt(info), instructions),
                messages: [],
                entries: [],
                fresh: [],
                pending: [],
                changes: new Map(),
                refresh: [],
                notes: [],
                usage: { input: 0, output: 0 },
                controller: null
            });

            return { sessionId: id, site: info };
        },

        async send (sessionId, text, options = {}) {
            const session = get(sessionId);
            const message = String(text || '').trim();
            const images = cleanImages(options.images);

            if (!message && !images.length) throw new Error('Type a message.');
            if (session.controller) throw new Error('The agent is still working.');

            // a new message answers open approvals with "rejected"
            for (const p of session.pending.splice(0)) {
                const e = session.entries.find(x => x.id === p.entryId);

                if (e) {
                    e.status = 'rejected';
                    session.fresh.push(e);
                }

                addToolResult(session, p.call, { rejected: true, reason: 'The user wrote a new message instead.' });
            }

            if (typeof options.autoApprove === 'boolean') session.autoApprove = options.autoApprove;
            if (options.providerId !== undefined) session.providerId = options.providerId;

            entry(session, images.length ? { type: 'user', text: message, images } : { type: 'user', text: message });
            const userMessage = { role: 'user', text: [...session.notes.splice(0), message || 'See the attached image(s).'].join('\n\n') };

            if (images.length) userMessage.images = images;
            session.messages.push(userMessage);
            await loop(session);
            return output(session);
        },

        /** decisions: { [callId]: { approve: boolean, reason?: string, result?: object } } */
        async resolve (sessionId, decisions = {}) {
            const session = get(sessionId);

            if (session.controller) throw new Error('The agent is still working.');

            const open = [];

            for (const p of session.pending) {
                const decision = decisions[p.callId];

                if (!decision) {
                    open.push(p);
                    continue;
                }

                const e = session.entries.find(x => x.id === p.entryId);

                try {
                    if (!decision.approve) {
                        e.status = 'rejected';
                        addToolResult(session, p.call, { rejected: true, reason: String(decision.reason || 'The user rejected this change.').slice(0, 2000) });
                    } else if (p.kind === 'client') {
                        e.status = 'done';
                        e.result = decision.result || { ok: true };
                        addToolResult(session, p.call, e.result);
                    } else {
                        await runWrite(session, p.call, p.plan, e);
                    }
                } catch (error) {
                    e.status = 'error';
                    e.error = error.message;
                    addToolResult(session, p.call, { error: error.message });
                }

                session.fresh.push(e);
            }

            session.pending = open;

            if (!open.length) await loop(session);
            return output(session);
        },

        undo (sessionId, changeId) {
            const session = get(sessionId);
            const change = session.changes.get(changeId);

            if (!change) throw new Error('Unknown change.');
            if (change.undone) return output(session);

            change.undo();
            change.undone = true;

            const e = session.entries.find(x => x.id === changeId);

            if (e) {
                e.status = 'undone';
                session.fresh.push(e);
            }

            session.refresh.push({ kind: e && e.name === 'write_theme_file' ? 'theme' : 'posts', postId: null });
            // tell the model with the next message (a tool call may still be waiting for its result)
            session.notes.push(`[The user undid this change: ${change.title}]`);
            return output(session);
        },

        cancel (sessionId) {
            const session = sessions.get(sessionId);

            if (session && session.controller) session.controller.abort();
            return true;
        },

        history (sessionId) {
            const session = get(sessionId);
            session.fresh = [];
            return { ...output(session), entries: session.entries };
        },

        close (sessionId) {
            const session = sessions.get(sessionId);

            if (session && session.controller) session.controller.abort();
            return sessions.delete(sessionId);
        },

        // for tests
        _sessions: sessions
    };
}

module.exports = { createAgent, systemPrompt, cleanImages, withRecentImages };
