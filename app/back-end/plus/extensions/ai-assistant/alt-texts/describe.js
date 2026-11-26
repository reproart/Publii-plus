/**
 * AI alt texts – the image file for the model (a responsive version Publii already made, or a downscaled copy)
 * and the request: image + article context → { alt, decorative } as structured JSON.
 */
const fs = require('fs');
const path = require('path');

const MAX_SIDE = 1280;
const MAX_BYTES = 4 * 1024 * 1024;
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

/**
 * The file of an image in the site: "#DOMAIN_NAME#a.jpg" → input/media/posts/<id>/a.jpg,
 * "media/files/x.png" → input/media/files/x.png. External images → null.
 */
function resolveFile (src, { siteDir, postId }) {
    let rel = String(src || '').trim();

    if (!rel || /^(https?:)?\/\//i.test(rel) || rel.startsWith('data:')) return null;

    rel = rel.replace(/^#DOMAIN_NAME#/, '').replace(/^file:\/+/, '/').split(/[?#]/)[0];

    try {
        rel = decodeURIComponent(rel);
    } catch (e) {
        // keep it
    }

    const media = rel.indexOf('media/');
    const file = media > -1
        ? path.join(siteDir, 'input', rel.slice(media))
        : path.join(siteDir, 'input', 'media', 'posts', String(postId), rel.replace(/^\/+/, ''));
    const root = path.join(siteDir, 'input', 'media');

    return file.startsWith(root + path.sep) && fs.existsSync(file) ? file : null;
}

/** Smaller copies Publii made for the theme: <dir>/responsive/<name>-<size>.<ext> */
function responsiveVersions (file) {
    const dir = path.join(path.dirname(file), 'responsive');
    const { name } = path.parse(file);

    try {
        return fs.readdirSync(dir).filter(f => f.startsWith(name + '-') && TYPES[path.extname(f).toLowerCase()]).map(f => path.join(dir, f));
    } catch (e) {
        return [];
    }
}

function dimensions (file) {
    try {
        const imageSize = require('image-size');
        const size = (imageSize.default || imageSize.imageSize || imageSize)(file);
        return { width: size.width || 0, height: size.height || 0 };
    } catch (e) {
        return { width: 0, height: 0 };
    }
}

/** Small version for the thumbnail in the UI (the smallest responsive copy, else the file itself) */
function thumbnailFile (file) {
    const versions = responsiveVersions(file).map(f => ({ f, size: fs.statSync(f).size })).sort((a, b) => a.size - b.size);
    return versions.length ? versions[0].f : file;
}

/**
 * Data URL of the image for the model, at most ~1280 px.
 * @returns {Promise<string|null>}
 */
async function imageForModel (file) {
    const ext = path.extname(file).toLowerCase();

    if (ext === '.svg') return null;

    // the largest responsive copy that is not larger than MAX_SIDE
    const candidates = [file, ...responsiveVersions(file)]
        .map(f => ({ f, ...dimensions(f), bytes: fs.statSync(f).size }))
        .filter(c => TYPES[path.extname(c.f).toLowerCase()] && c.width && Math.max(c.width, c.height) <= MAX_SIDE && c.bytes <= MAX_BYTES)
        .sort((a, b) => b.width - a.width);

    if (candidates.length) {
        const pick = candidates[0].f;
        return `data:${TYPES[path.extname(pick).toLowerCase()]};base64,${fs.readFileSync(pick).toString('base64')}`;
    }

    try {
        const sharp = require('sharp');
        const buffer = await sharp(file, { animated: false }).rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
        return `data:image/jpeg;base64,${buffer.toString('base64')}`;
    } catch (e) {
        if (TYPES[ext] && fs.statSync(file).size <= MAX_BYTES) return `data:${TYPES[ext]};base64,${fs.readFileSync(file).toString('base64')}`;
        return null;
    }
}

const SCHEMA = {
    type: 'object',
    properties: {
        alt: { type: 'string', description: 'The alt text; empty when decorative' },
        decorative: { type: 'boolean', description: 'true when the image carries no information' }
    },
    required: ['alt', 'decorative'],
    additionalProperties: false
};

function systemPrompt (language) {
    return [
        'You write alt text (alternative text) for images on a website – for people using screen readers and for image search.',
        language ? `Write in the language with code "${language}".` : 'Write in the language of the article text.',
        'One sentence, at most 125 characters.',
        'Describe what matters in the image for this article: the subject and what happens; for charts, diagrams and screenshots the main ' +
            'takeaway; short text that is visible in the image if it matters.',
        'Do not start with "Image of", "Picture of" or "Photo of" (say "Chart:" or "Screenshot:" only when the kind of image matters).',
        'No quotation marks, emoji, file names or keyword stuffing; do not repeat the caption word for word.',
        'Use the article context only to choose what to mention – describe what is really visible, do not invent details.',
        'If the image is purely decorative (a pattern, a divider, a background without information), set decorative to true and alt to "".'
    ].join('\n');
}

function userPrompt ({ title, image }) {
    const lines = [`Article title: ${title || '(none)'}`];

    if (image.kind === 'featured') lines.push('This is the featured (cover) image of the article.');
    if (image.context && image.context.before) lines.push(`Text before the image: ${image.context.before}`);
    if (image.context && image.context.after) lines.push(`Text after the image: ${image.context.after}`);
    if (image.caption) lines.push(`Caption shown under the image: ${image.caption}`);

    lines.push(`File name: ${path.basename(String(image.src || '').replace(/^#DOMAIN_NAME#/, '').split(/[?#]/)[0])}`, 'Write the alt text for the attached image.');
    return lines.join('\n');
}

/**
 * @param {object} o
 * @param {function} o.generate   generateStructured({ ...}) of the provider layer
 * @param {object} o.provider     { config, apiKey }
 * @returns {Promise<{ alt: string, decorative: boolean }>}
 */
async function describeImage ({ generate, provider, dataUrl, title, image, language, instructions = s => s, signal }) {
    const out = await generate({
        config: provider.config,
        apiKey: provider.apiKey,
        system: instructions(systemPrompt(language)),
        user: userPrompt({ title, image }),
        images: [dataUrl],
        schema: SCHEMA,
        schemaName: 'alt_text',
        signal
    });

    const alt = String(out.data.alt || '').replace(/^["'«“]+|["'»”]+$/g, '').replace(/\s+/g, ' ').trim();
    return { alt: out.data.decorative ? '' : alt, decorative: !!out.data.decorative };
}

module.exports = { resolveFile, imageForModel, thumbnailFile, describeImage, systemPrompt, userPrompt, SCHEMA };
