import { ThinaiLanguageMetaData } from 'thinai-language';
import chalk from 'chalk';
import { Command } from 'commander';
import { contextAction, impactAction, inspectAction, validateAction } from './model.js';
import { startMcpServer } from './mcp.js';
import * as url from 'node:url';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

const packagePath = path.resolve(__dirname, '..', 'package.json');
const packageContent = await fs.readFile(packagePath, 'utf-8');

export default async function(): Promise<void> {
    const program = new Command();

    program.version(JSON.parse(packageContent).version);

    const fileExtensions = ThinaiLanguageMetaData.fileExtensions.join(', ');
    program
        .command('inspect')
        .argument('<file>', `source file (possible file extensions: ${fileExtensions})`)
        .option('--out <file>', 'write JSON to a file')
        .option('--json', 'emit JSON (default)')
        .description('exports the Thinai model graph as JSON')
        .action(async (fileName: string, options: { out?: string; json?: boolean }) => {
            await runAction(() => inspectAction(fileName, options));
        });

    program
        .command('context')
        .argument('<file>', `source file (possible file extensions: ${fileExtensions})`)
        .argument('<element>', 'model element ID, for example Aggregate:Ordering.Order')
        .option('--format <format>', 'json or md', 'json')
        .option('--depth <n>', 'reference depth', '1')
        .option('--out <file>', 'write the context slice to a file')
        .description('emits a task-scoped model context slice')
        .action(async (fileName: string, element: string, options: { format?: string; depth?: string; out?: string }) => {
            await runAction(() => contextAction(fileName, element, options));
        });

    program
        .command('impact')
        .argument('<file>', `source file (possible file extensions: ${fileExtensions})`)
        .argument('<element>', 'model element ID')
        .option('--json', 'emit JSON')
        .option('--out <file>', 'write the impact report to a file')
        .description('reports model elements that reference an element')
        .action(async (fileName: string, element: string, options: { json?: boolean; out?: string }) => {
            await runAction(() => impactAction(fileName, element, options));
        });

    program
        .command('validate')
        .argument('<file>', `source file (possible file extensions: ${fileExtensions})`)
        .option('--json', 'emit JSON diagnostics')
        .description('validates a Thinai model and its imports')
        .action(async (fileName: string, options: { json?: boolean }) => {
            await runAction(() => validateAction(fileName, options));
        });

    program
        .command('mcp')
        .argument('<file>', `source file (possible file extensions: ${fileExtensions})`)
        .description('starts a read-only Model Context Protocol server over stdio')
        .action(async (fileName: string) => {
            try {
                await startMcpServer(fileName);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(chalk.red(message));
                process.exitCode = 1;
            }
        });

    await program.parseAsync(process.argv);
}

async function runAction(action: () => Promise<void>): Promise<void> {
    try {
        await action();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(message));
        process.exitCode = 1;
    }
}
