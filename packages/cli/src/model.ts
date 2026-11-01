import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
    computeImpact,
    createContextSlice,
    exportThinaiModel,
    renderContextMarkdown,
    type ThinaiModelDiagnostic,
    type ThinaiModelExport
} from 'thinai-language';
import { loadDocuments } from './util.js';
import { createThinaiServices } from 'thinai-language';
import { NodeFileSystem } from 'langium/node';
import { URI } from 'langium';

export interface InspectOptions {
    out?: string;
    json?: boolean;
}

export interface ContextOptions {
    format?: string;
    depth?: string;
    out?: string;
}

export interface ImpactOptions {
    json?: boolean;
    out?: string;
    depth?: string;
    limit?: string;
}

export interface ValidateOptions {
    json?: boolean;
}

export async function loadModel(fileName: string): Promise<ThinaiModelExport> {
    const services = createThinaiServices(NodeFileSystem).Thinai;
    const documents = await loadDocuments(fileName, services);
    return exportThinaiModel(documents, { rootUri: URI.file(path.resolve(fileName)).toString() });
}

export async function inspectAction(fileName: string, options: InspectOptions): Promise<void> {
    const model = await loadModel(fileName);
    await writeOutput(json(model), options.out);
    setErrorExitCode(model.diagnostics);
}

export async function contextAction(fileName: string, elementId: string, options: ContextOptions): Promise<void> {
    const model = await loadModel(fileName);
    const format = options.format ?? 'json';
    if (format !== 'json' && format !== 'md' && format !== 'markdown') {
        throw new Error(`Unknown context format '${format}'. Expected json, md, or markdown.`);
    }
    const depth = Number.parseInt(options.depth ?? '1', 10);
    const slice = createContextSlice(model, elementId, { depth: Number.isFinite(depth) ? depth : 1 });
    const output = format === 'md' || format === 'markdown'
        ? renderContextMarkdown(slice)
        : json(slice);
    await writeOutput(output, options.out);
}

export async function impactAction(fileName: string, elementId: string, options: ImpactOptions): Promise<void> {
    const model = await loadModel(fileName);
    const depth = Number.parseInt(options.depth ?? '1', 10);
    const limit = Number.parseInt(options.limit ?? '200', 10);
    const impact = computeImpact(model, elementId, {
        depth: Number.isFinite(depth) ? depth : 1,
        limit: Number.isFinite(limit) ? limit : 200
    });
    await writeOutput(options.json ? json(impact) : impactSummary(impact), options.out);
}

export async function validateAction(fileName: string, options: ValidateOptions): Promise<void> {
    const diagnostics = (await loadModel(fileName)).diagnostics;
    if (options.json) {
        await writeOutput(json({ diagnostics }));
    } else if (diagnostics.length === 0) {
        console.log(chalk.green('No diagnostics.'));
    } else {
        for (const diagnostic of diagnostics) {
            console.log(formatDiagnostic(diagnostic));
        }
    }
    setErrorExitCode(diagnostics);
}

function json(value: unknown): string {
    return `${JSON.stringify(value, undefined, 2)}\n`;
}

async function writeOutput(output: string, destination?: string): Promise<void> {
    if (!destination) {
        process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
        return;
    }
    await fs.mkdir(path.dirname(path.resolve(destination)), { recursive: true });
    await fs.writeFile(path.resolve(destination), output.endsWith('\n') ? output : `${output}\n`, 'utf8');
}

function setErrorExitCode(diagnostics: ThinaiModelDiagnostic[]): void {
    if (diagnostics.some(diagnostic => diagnostic.severity === 1)) {
        process.exitCode = 1;
    }
}

function formatDiagnostic(diagnostic: ThinaiModelDiagnostic): string {
    const severity = diagnostic.severity === 1 ? 'error'
        : diagnostic.severity === 2 ? 'warning'
            : diagnostic.severity === 3 ? 'info'
                : 'hint';
    return `${diagnostic.uri}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${severity}: ${diagnostic.message}`;
}

function impactSummary(impact: ReturnType<typeof computeImpact>): string {
    const lines = [
        `Impact of ${impact.rootId}`,
        `Depth: ${impact.depth}`,
        `Changed elements: ${impact.changedIds.length}`,
        `Incoming references: ${impact.incoming.length}`,
        `Affected elements: ${impact.returned}`
    ];
    if (impact.truncated) {
        lines.push(`Truncated: ${impact.totalAffected - impact.returned} affected elements not shown`);
    }
    if (impact.affectedIds.length > 0) {
        lines.push('', 'Affected:');
        for (const id of impact.affectedIds) {
            lines.push(`- ${id}`);
        }
    }
    return `${lines.join('\n')}\n`;
}
