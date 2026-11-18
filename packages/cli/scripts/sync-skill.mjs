import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const source = fileURLToPath(new URL('../../../.agents/skills/thinai-model', import.meta.url));
const target = fileURLToPath(new URL('../skills/thinai-model', import.meta.url));

if (!existsSync(source)) {
    console.error(`Thinai skill not found at ${source}`);
    process.exit(1);
}

await rm(target, { recursive: true, force: true });
await mkdir(dirname(target), { recursive: true });
await cp(source, target, { recursive: true });
console.log(`Copied Thinai skill from ${source} to ${target}`);
