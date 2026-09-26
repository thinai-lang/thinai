import { createLLMProvider, type GenerateOptions, type LLMProvider } from './llm-provider.js';

let provider: LLMProvider | undefined;

/**
 * Send one evaluation prompt through the configured provider. Provider
 * selection remains behind this function so other adapters can be added later.
 */
export async function generateResponse(prompt: string, options: GenerateOptions = {}): Promise<string> {
    provider ??= createLLMProvider();
    return provider.generateResponse(prompt, options);
}

/**
 * Extract the first fenced code block from a model response.
 * If `language` is supplied, only a matching language fence is returned.
 */
export function extractCodeBlock(text: string, language?: string): string | null {
    const pattern = language
        ? new RegExp(`\\x60\\x60\\x60${language}\\n([\\s\\S]*?)\\x60\\x60\\x60`)
        : /```[\w-]*\n([\s\S]*?)```/;
    const match = text.match(pattern);
    return match ? match[1].trim() : null;
}

/**
 * Computes a normalized character-level similarity score between two strings.
 */
export function calculateSimilarity(actual: string, expected: string): number {
    const first = actual.trim().toLowerCase();
    const second = expected.trim().toLowerCase();

    if (first === second) {
        return 1;
    }
    if (first.length === 0 || second.length === 0) {
        return 0;
    }

    return 1 - levenshteinDistance(first, second) / Math.max(first.length, second.length);
}

function levenshteinDistance(first: string, second: string): number {
    const matrix: number[][] = [];
    for (let row = 0; row <= first.length; row++) {
        matrix[row] = [row];
    }
    for (let column = 0; column <= second.length; column++) {
        matrix[0][column] = column;
    }

    for (let row = 1; row <= first.length; row++) {
        for (let column = 1; column <= second.length; column++) {
            const cost = first[row - 1] === second[column - 1] ? 0 : 1;
            matrix[row][column] = Math.min(
                matrix[row - 1][column] + 1,
                matrix[row][column - 1] + 1,
                matrix[row - 1][column - 1] + cost
            );
        }
    }
    return matrix[first.length][second.length];
}
