/** Labels of the translation states (shared by the card and the dialog) */
export const STATES = {
    new: { label: 'to translate', tone: 'todo' },
    outdated: { label: 'changed – to update', tone: 'todo' },
    current: { label: 'up to date', tone: 'ok' },
    edited: { label: 'edited there', tone: 'notice' },
    linked: { label: 'existing post kept', tone: 'notice' },
    deleted: { label: 'deleted there', tone: 'notice' },
    waiting: { label: 'not published', tone: 'muted' },
    'source-deleted': { label: 'post deleted', tone: 'muted' }
};

export function stateLabel (item) {
    if (item.error) return 'failed';
    return (STATES[item.state] || { label: item.state }).label;
}

export function stateTone (item) {
    if (item.error) return 'error';
    return (STATES[item.state] || { tone: 'muted' }).tone;
}

export function entrySummary (entry) {
    const parts = [];

    if (entry.created) parts.push(`${entry.created} translated`);
    if (entry.updated) parts.push(`${entry.updated} updated`);
    if (entry.meta) parts.push(`${entry.meta} status/date change(s) copied`);
    if (entry.linked) parts.push(`${entry.linked} existing post(s) linked`);
    if (entry.unpublished) parts.push(`${entry.unpublished} to draft`);
    if (entry.links) parts.push(`${entry.links} link(s) fixed`);
    if (entry.errors) parts.push(`${entry.errors} failed`);
    if (entry.remaining) parts.push(`${entry.remaining} left for the next run`);
    return parts.length ? parts.join(', ') : (entry.error ? 'failed' : 'nothing to translate');
}

export function triggerLabel (trigger) {
    return { manual: 'manual', schedule: 'automatic' }[trigger] || trigger;
}
