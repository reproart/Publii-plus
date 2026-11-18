/**
 * Line-based unified diff (Myers algorithm), output compatible with `git apply` / `patch -p1`.
 * Shared by Publii Plus extensions (theme editor, plugin workshop).
 */

function splitLines (text) {
    if (text === null || text === undefined || text === '') return [];

    const lines = String(text).replace(/\r\n/g, '\n').split('\n');

    // A trailing newline does not create an extra empty line
    if (lines[lines.length - 1] === '') lines.pop();

    return lines;
}

/** Myers O((N+M)D) diff -> list of operations { type: ' ' | '-' | '+', line } */
function diffLines (a, b) {
    const n = a.length;
    const m = b.length;
    const max = n + m;
    const offset = max + 1;
    const v = new Array(2 * max + 3).fill(0);
    const trace = [];

    outer:
    for (let d = 0; d <= max; d++) {
        trace.push(v.slice());

        for (let k = -d; k <= d; k += 2) {
            let x;

            if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
            else x = v[offset + k - 1] + 1;

            let y = x - k;

            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }

            v[offset + k] = x;

            if (x >= n && y >= m) break outer;
        }
    }

    // Backtrack
    const ops = [];
    let x = n;
    let y = m;

    for (let d = trace.length - 1; d >= 0; d--) {
        const vd = trace[d];
        const k = x - y;
        let prevK;

        if (k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])) prevK = k + 1;
        else prevK = k - 1;

        const prevX = vd[offset + prevK];
        const prevY = prevX - prevK;

        while (x > prevX && y > prevY) {
            ops.push({ type: ' ', line: a[x - 1] });
            x--;
            y--;
        }

        if (d > 0) {
            if (x === prevX) ops.push({ type: '+', line: b[y - 1] });
            else ops.push({ type: '-', line: a[x - 1] });
        }

        x = prevX;
        y = prevY;
    }

    return ops.reverse();
}

/**
 * @param {string|null} oldText  null = file did not exist
 * @param {string|null} newText  null = file deleted
 * @param {object} options { oldName, newName, context = 3 }
 * @returns {string} unified diff ('' when equal)
 */
function createUnifiedDiff (oldText, newText, { oldName = 'a/file', newName = 'b/file', context = 3 } = {}) {
    const a = splitLines(oldText);
    const b = splitLines(newText);
    const ops = diffLines(a, b);

    if (!ops.some(op => op.type !== ' ')) return '';

    const hunks = [];
    let i = 0;

    while (i < ops.length) {
        if (ops[i].type === ' ') {
            i++;
            continue;
        }

        // hunk start with leading context
        let start = Math.max(0, i - context);
        let end = i;

        // extend while changes are within 2*context of each other
        while (end < ops.length) {
            if (ops[end].type !== ' ') {
                end++;
                continue;
            }

            let run = 0;

            while (end + run < ops.length && ops[end + run].type === ' ') run++;

            if (end + run >= ops.length || run > context * 2) {
                end = Math.min(ops.length, end + Math.min(run, context));
                break;
            }

            end += run;
        }

        hunks.push([start, end]);
        i = end;
    }

    const lines = [`--- ${oldText === null ? '/dev/null' : oldName}`, `+++ ${newText === null ? '/dev/null' : newName}`];

    for (const [start, end] of hunks) {
        // line numbers of the hunk start
        let oldLine = 1;
        let newLine = 1;

        for (let j = 0; j < start; j++) {
            if (ops[j].type !== '+') oldLine++;
            if (ops[j].type !== '-') newLine++;
        }

        const body = ops.slice(start, end);
        const oldCount = body.filter(op => op.type !== '+').length;
        const newCount = body.filter(op => op.type !== '-').length;

        lines.push(`@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`);
        body.forEach(op => lines.push(op.type + op.line));
    }

    return lines.join('\n') + '\n';
}

module.exports = { createUnifiedDiff, diffLines, splitLines };
