/** Titles and short explanations of the site check results (UI is English, like the rest of Publii Plus). */
export const CHECKS = {
    'noindex-site': { title: 'Website hidden from search engines', help: 'The "noindex" option for the whole website is on in Site settings → SEO.' },
    'noindex-home': { title: 'Homepage hidden from search engines', help: 'The homepage has meta robots "noindex".' },
    'robots-blocked': { title: 'robots.txt blocks search engines', help: 'robots.txt has "Disallow: /" for all robots (Site settings → SEO → robots.txt).' },
    'broken-link': { title: 'Broken links', help: 'Links to pages of this website that do not exist.' },
    'missing-file': { title: 'Missing files', help: 'Images, styles or scripts referenced by the page are not in the website.' },
    'external-broken': { title: 'Broken external links', help: 'The linked page or domain does not exist (404, 410, unknown domain).' },
    'canonical-broken': { title: 'Canonical URL points nowhere', help: 'The canonical link leads to a page that does not exist.' },
    'title-missing': { title: 'Pages without a title', help: 'No <title> element.' },
    'missing-anchor': { title: 'Links to missing sections', help: 'The page exists, but the #section in the link does not.' },
    'image-alt': { title: 'Images without alt text', help: 'Describe images for screen readers and image search; decorative images need an empty alt.' },
    'image-heavy': { title: 'Heavy images', help: 'Image files over 500 KB slow pages down. Compress them or upload smaller versions.' },
    'page-heavy': { title: 'Heavy pages', help: 'Pages loading more than 3 MB (HTML, styles, scripts and images).' },
    'title-duplicate': { title: 'Duplicate titles', help: 'Several pages with the same title compete in search results.' },
    'h1-missing': { title: 'Pages without H1', help: 'Posts and pages should have one main heading.' },
    'canonical-external': { title: 'Canonical URL on another website', help: 'Search engines will index the other address instead of this page.' },
    'mixed-content': { title: 'Insecure resources (http://)', help: 'Loaded over http:// on an https:// website – browsers block or warn.' },
    'external-error': { title: 'External links with errors', help: 'Server error, timeout or certificate problem – may be temporary.' },
    'noindex-page': { title: 'Posts hidden from search engines', help: 'Meta robots "noindex" – make sure this is intended.' },
    'title-long': { title: 'Long titles', help: 'Search engines show about 70 characters.' },
    'description-missing': { title: 'No meta description', help: 'Search engines then show a random piece of text.' },
    'description-duplicate': { title: 'Duplicate meta descriptions', help: 'The same description on several pages.' },
    'h1-multiple': { title: 'Several H1 headings', help: 'Usually one H1 per page is enough.' },
    'lang-missing': { title: 'No page language', help: 'The <html> element has no lang attribute.' },
    'external-unverified': { title: 'External links not verified', help: 'The website refused automated checks (403/429) or is a social network – check by hand if needed.' },
    'external-redirect': { title: 'External links that redirect', help: 'The link leads to another website now – update it if the target moved.' }
};

export const SEVERITY = {
    error: { label: 'Errors', one: 'error' },
    warning: { label: 'Warnings', one: 'warning' },
    notice: { label: 'Notices', one: 'notice' }
};

export function ago (at) {
    if (!at) return '';

    const minutes = Math.round((Date.now() - at) / 60000);

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;

    const hours = Math.round(minutes / 60);

    if (hours < 24) return `${hours} h ago`;

    const days = Math.round(hours / 24);
    return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function countsText (counts) {
    if (!counts) return '';

    const parts = [];

    if (counts.error) parts.push(`${counts.error} error${counts.error === 1 ? '' : 's'}`);
    if (counts.warning) parts.push(`${counts.warning} warning${counts.warning === 1 ? '' : 's'}`);
    if (counts.notice) parts.push(`${counts.notice} notice${counts.notice === 1 ? '' : 's'}`);

    return parts.length ? parts.join(', ') : 'no problems found';
}

/** Report as Markdown (for the clipboard / an issue tracker / the AI agent). */
export function reportMarkdown (report, site) {
    const lines = [`# Site check: ${site}`, '', `${new Date(report.at).toLocaleString()} · ${report.pages} pages · ${countsText(report.counts)}`, ''];
    const groups = new Map();

    report.issues.forEach(i => {
        if (!groups.has(i.check)) groups.set(i.check, []);
        groups.get(i.check).push(i);
    });

    for (const [check, items] of groups) {
        lines.push(`## ${(CHECKS[check] || { title: check }).title} (${items.length})`, '');
        items.forEach(i => lines.push(`- ${i.page || 'website'}${i.target ? ' → ' + i.target : ''}${i.text ? ` ("${i.text}")` : ''}${i.detail ? ' – ' + i.detail : ''}`));
        lines.push('');
    }

    return lines.join('\n');
}
