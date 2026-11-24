/**
 * Images for the agent chat (paste / drop / file picker), prepared in the renderer:
 * scaled down to MAX_SIDE on the long side and returned as a data URL. Small PNGs that need no
 * scaling stay PNG (sharp screenshots); everything else becomes JPEG on a white background.
 */
export const MAX_SIDE = 1600;
export const MAX_IMAGES = 4;
const KEEP_PNG_BYTES = 1.5 * 1024 * 1024;

export function imageFiles (list) {
    return [...(list || [])]
        .map(item => (item && item.kind === 'file' ? item.getAsFile() : item))
        .filter(file => file && /^image\/(png|jpeg|webp|gif)$/.test(file.type));
}

/** Target size keeping the aspect ratio */
export function fitSize (width, height, max = MAX_SIDE) {
    const scale = Math.min(1, max / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scaled: scale < 1 };
}

function readAsDataUrl (file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Cannot read the image.'));
        reader.readAsDataURL(file);
    });
}

function loadImage (src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('This image format cannot be read.'));
        img.src = src;
    });
}

export async function prepareImage (file) {
    const original = await readAsDataUrl(file);
    const img = await loadImage(original);
    const size = fitSize(img.naturalWidth, img.naturalHeight);

    if (!size.scaled && file.type === 'image/png' && file.size <= KEEP_PNG_BYTES) return original;

    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white'; // JPEG has no transparency: transparent screenshots get a white background
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.drawImage(img, 0, 0, size.width, size.height);
    return canvas.toDataURL('image/jpeg', 0.88);
}
