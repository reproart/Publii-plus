/**
 * Secret storage for Publii Plus extensions: system keychain (service + account), with an
 * Electron safeStorage-encrypted JSON file as fallback. Secrets never go to the renderer.
 */
const fs = require('fs');
const path = require('path');

function createSecretStore ({ passwordStorage, safeStorage, secretsFile, service }) {
    const readFile = () => {
        try {
            return JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
        } catch (e) {
            return {};
        }
    };

    const writeFile = data => {
        fs.mkdirSync(path.dirname(secretsFile), { recursive: true });
        fs.writeFileSync(secretsFile, JSON.stringify(data, null, 2), { mode: 0o600 });
    };

    const canEncrypt = () => !!(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable());

    return {
        async get (id) {
            if (passwordStorage) {
                try {
                    const value = await passwordStorage.getPassword(service, id);
                    if (value) return value;
                } catch (e) {
                    // keychain unavailable – try the encrypted file
                }
            }

            const stored = readFile()[id];

            if (stored && canEncrypt()) {
                try {
                    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
                } catch (e) {
                    return '';
                }
            }

            return '';
        },
        async set (id, value) {
            if (passwordStorage) {
                try {
                    await passwordStorage.setPassword(service, id, value);
                    const data = readFile();

                    if (id in data) {
                        delete data[id];
                        writeFile(data);
                    }

                    return 'keychain';
                } catch (e) {
                    // fall back below
                }
            }

            if (!canEncrypt()) {
                throw new Error('Neither the system keychain nor encrypted storage is available – the API key cannot be stored safely.');
            }

            const data = readFile();
            data[id] = safeStorage.encryptString(value).toString('base64');
            writeFile(data);
            return 'encrypted-file';
        },
        async remove (id) {
            if (passwordStorage) {
                try {
                    await passwordStorage.deletePassword(service, id);
                } catch (e) {
                    // not stored there
                }
            }

            const data = readFile();

            if (id in data) {
                delete data[id];
                writeFile(data);
            }
        }
    };
}

module.exports = { createSecretStore };
