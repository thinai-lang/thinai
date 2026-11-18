import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, test } from 'vitest';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const syncSkill = fileURLToPath(new URL('../scripts/sync-skill.mjs', import.meta.url));

async function withTempDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(path.join(tmpdir(), 'thinai-skill-'));
    try {
        return await run(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

describe('skill command', () => {
    beforeAll(async () => {
        await exec(process.execPath, [syncSkill]);
    });

    test('prints the bundled skill', async () => {
        const { stdout } = await exec(process.execPath, [cli, 'skill']);
        expect(stdout).toContain('# Working with Thinai Models');
        expect(stdout).toContain('references/authoring.md');
        expect(stdout).toContain('references/validation.md');
    });

    test('copies the complete skill folder', async () => {
        await withTempDirectory(async directory => {
            const target = path.join(directory, 'thinai-model');
            await exec(process.execPath, [cli, 'skill', '--copy', '--out', target]);

            await expect(stat(path.join(target, 'SKILL.md'))).resolves.toBeTruthy();
            await expect(stat(path.join(target, 'references', 'authoring.md'))).resolves.toBeTruthy();
            await expect(stat(path.join(target, 'references', 'examples', 'strategic.tni'))).resolves.toBeTruthy();
        });
    });

    test('refuses to overwrite without --force and requires --copy with --out', async () => {
        await withTempDirectory(async directory => {
            const target = path.join(directory, 'thinai-model');
            await exec(process.execPath, [cli, 'skill', '--copy', '--out', target]);

            await expect(exec(process.execPath, [cli, 'skill', '--copy', '--out', target]))
                .rejects.toMatchObject({ stderr: expect.stringContaining('already exists') });

            await expect(exec(process.execPath, [cli, 'skill', '--out', target]))
                .rejects.toMatchObject({ stderr: expect.stringContaining('--out requires --copy') });

            await exec(process.execPath, [cli, 'skill', '--copy', '--out', target, '--force']);
            await expect(readFile(path.join(target, 'SKILL.md'), 'utf8'))
                .resolves.toContain('# Working with Thinai Models');
        });
    });
});
