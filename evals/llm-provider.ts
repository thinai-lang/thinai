import OpenAI from 'openai';

export interface GenerateOptions {
    systemPrompt?: string;
}

export interface LLMProvider {
    generateResponse(prompt: string, options?: GenerateOptions): Promise<string>;
}

const API_KEY_PLACEHOLDER = 'not-a-real-api-key';

export class OpenAICompatibleProvider implements LLMProvider {
    private readonly client: OpenAI;
    private readonly model: string;

    constructor(options: { baseURL?: string; apiKey?: string; model?: string; client?: OpenAI } = {}) {
        this.model = options.model ?? process.env.EVAL_LLM_MODEL ?? '';
        if (!this.model) {
            throw new Error('Set EVAL_LLM_MODEL to the model identifier supported by your API.');
        }

        const baseURL = options.baseURL ?? process.env.EVAL_LLM_BASE_URL;
        this.client = options.client ?? new OpenAI({
            ...(baseURL ? { baseURL } : {}),
            // The SDK requires a non-empty key even when the configured API does not use authentication.
            apiKey: options.apiKey ?? process.env.EVAL_LLM_API_KEY ?? API_KEY_PLACEHOLDER,
            timeout: 120_000,
            maxRetries: 0
        });
    }

    async generateResponse(prompt: string, options: GenerateOptions = {}): Promise<string> {
        const messages = [
            ...(options.systemPrompt ? [{ role: 'system' as const, content: options.systemPrompt }] : []),
            { role: 'user' as const, content: prompt }
        ];

        let completion: Awaited<ReturnType<OpenAI['chat']['completions']['create']>>;
        try {
            completion = await this.client.chat.completions.create({
                model: this.model,
                messages
            });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(
                `Could not complete the evaluation request using model '${this.model}' at ${this.client.baseURL}. ` +
                `Check the configured API endpoint and credentials. (${reason})`,
                { cause: error }
            );
        }

        const response = completion.choices[0]?.message.content;
        if (typeof response !== 'string' || response.trim().length === 0) {
            throw new Error(`The evaluation API returned no text content for model '${this.model}'.`);
        }
        return response;
    }
}

export function createLLMProvider(): LLMProvider {
    return new OpenAICompatibleProvider();
}
