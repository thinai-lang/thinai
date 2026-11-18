import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const skillDirectory = path.join(packageRoot, 'skills', 'thinai-model');
const skillFile = path.join(skillDirectory, 'SKILL.md');

export interface SkillOptions {
    copy?: boolean;
    out?: string;
    force?: boolean;
}

export async function skillAction(options: SkillOptions): Promise<void> {
    if (options.out && !options.copy) {
        throw new Error('--out requires --copy.');
    }
    if (options.copy) {
        await copySkill(options);
        return;
    }
    process.stdout.write(await fs.readFile(skillFile, 'utf8'));
}

async function copySkill(options: SkillOptions): Promise<void> {
    const target = options.out
        ? path.resolve(options.out)
        : path.resolve('.agents', 'skills', 'thinai-model');

    if (!options.force) {
        const exists = await fs.stat(target).then(() => true, () => false);
        if (exists) {
            throw new Error(`Skill directory already exists at ${target}. Use --force to overwrite.`);
        }
    }

    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(skillDirectory, target, { recursive: true });
    console.log(`Copied Thinai skill to ${target}`);
}
