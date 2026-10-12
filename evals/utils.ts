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
    const lineEnding = String.raw`\r?\n`;
    const escapedLanguage = language?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = language
        ? new RegExp(`\\x60\\x60\\x60${escapedLanguage}${lineEnding}([\\s\\S]*?)\\x60\\x60\\x60`)
        : new RegExp(String.raw`\x60\x60\x60[\w-]*${lineEnding}([\s\S]*?)\x60\x60\x60`);
    const match = text.match(pattern);
    return match ? match[1].trim() : null;
}
