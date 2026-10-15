import { createThinaiServices, ThinaiLanguageMetaData } from 'thinai-language';
import chalk from 'chalk';
import { Command } from 'commander';
import { extractDocuments } from './util.js';
import { generateJavaScript } from './generator.js';
import { NodeFileSystem } from 'langium/node';
import * as url from 'node:url';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

const packagePath = path.resolve(__dirname, '..', 'package.json');
const packageContent = await fs.readFile(packagePath, 'utf-8');

export const generateAction = async (fileName: string, opts: GenerateOptions): Promise<void> => {
    const services = createThinaiServices(NodeFileSystem).Thinai;
    const documents = await extractDocuments(fileName, services);
    const generatedFilePath = await generateJavaScript(documents, fileName, opts.destination);
    console.log(chalk.green(`JavaScript code generated successfully: ${generatedFilePath}`));
};

export type GenerateOptions = {
    destination?: string;
}

export default async function(): Promise<void> {
    const program = new Command();

    program.version(JSON.parse(packageContent).version);

    const fileExtensions = ThinaiLanguageMetaData.fileExtensions.join(', ');
    program
        .command('generate')
        .argument('<file>', `source file (possible file extensions: ${fileExtensions})`)
        .option('-d, --destination <dir>', 'destination directory of generating')
        .description('generates a JavaScript summary from a Thinai model and its imported files')
        .action(async (fileName: string, options: GenerateOptions) => {
            try {
                await generateAction(fileName, options);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(chalk.red(message));
                process.exitCode = 1;
            }
        });

    await program.parseAsync(process.argv);
}
