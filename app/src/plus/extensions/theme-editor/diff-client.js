// Renderer-side wrapper around the shared unified diff (same code as the main process).
import { createUnifiedDiff } from '../../../../back-end/plus/lib/unified-diff.js';

export function createDiff (original, edited, rel) {
    return createUnifiedDiff(original, edited, { oldName: 'a/' + rel, newName: 'b/' + rel });
}
