import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const PLUGINS_DIR = path.join(process.cwd(), 'dist/plugins');

describe('Plugin Loading', () => {
    let pluginFiles: string[] = [];

    beforeAll(() => {
        pluginFiles = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js'));
    });

    it('has plugins directory', () => expect(fs.existsSync(PLUGINS_DIR)).toBe(true));
    it('has more than 100 plugins', () => expect(pluginFiles.length).toBeGreaterThan(100));

    it('loads 20 sample plugins without errors', async () => {
        const errors: string[] = [];
        for (const file of pluginFiles.slice(0, 20)) {
            try {
                const mod = await import(path.join(PLUGINS_DIR, file));
                if (!mod.default) errors.push(`${file}: no default export`);
            } catch(e: any) {
                errors.push(`${file}: ${e.message}`);
            }
        }
        expect(errors).toEqual([]);
    });
});
