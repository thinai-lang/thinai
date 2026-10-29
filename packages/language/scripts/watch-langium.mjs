import { watch } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const grammarPath = fileURLToPath(new URL('../syntaxes/thinai.tmLanguage.json', import.meta.url));
const patchScript = fileURLToPath(new URL('./patch-textmate.mjs', import.meta.url));
const langium = spawn('langium', ['generate', '--watch'], { stdio: 'inherit' });
let debounce;

const watcher = watch(grammarPath, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
        const result = spawnSync(process.execPath, [patchScript], { stdio: 'inherit' });
        if (result.status !== 0) {
            console.error('Failed to apply Thinai TextMate highlighting rules.');
        }
    }, 100);
});

langium.on('exit', code => {
    watcher.close();
    clearTimeout(debounce);
    process.exitCode = code ?? 1;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => langium.kill(signal));
}
