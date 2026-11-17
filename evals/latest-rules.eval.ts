import { describe, evaluation, beforeEach } from 'langium-ai-tools/evals';
import { LangiumEvaluator } from 'langium-ai-tools/evaluator';
import type { EvalContext } from 'langium-ai-tools/evals';
import { EmptyFileSystem } from 'langium';
import { createThinaiServices } from '../packages/language/src/thinai-module.js';
import { extractCodeBlock, generateResponse } from './utils.js';

const services = createThinaiServices(EmptyFileSystem).Thinai;
const evaluator = new LangiumEvaluator(services);

async function generateAndValidate(prompt: string, context: EvalContext) {
    const response = await generateResponse(prompt, { systemPrompt: context.systemPrompt });
    const code = extractCodeBlock(response, 'thinai') ?? extractCodeBlock(response) ?? response;
    const result = await evaluator.evaluate(code);
    const diagnostics = result.data.diagnostics ?? [];
    const errors = diagnostics.filter(diagnostic => diagnostic.severity === 1);
    const warnings = diagnostics.filter(diagnostic => diagnostic.severity === 2);
    return { code, result, errors, warnings, valid: !result.data.failures && !result.data.errors && errors.length === 0 };
}

function featureScore(code: string, required: string[]): { score: number; missing: string[] } {
    const normalized = code.toLowerCase().replace(/\s+/g, ' ');
    const missing = required.filter(feature => !normalized.includes(feature.toLowerCase()));
    return { score: (required.length - missing.length) / required.length, missing };
}

describe('Thinai latest-rule evaluations', () => {
    beforeEach(async () => {
        await services.shared.workspace.WorkspaceManager.initializeWorkspace([]);
    });

    evaluation('places customer and supplier integration patterns on the correct endpoints', async (context: EvalContext) => {
        const generated = await generateAndValidate(
            'Generate a valid single-file Thinai model with bounded contexts Ordering and Shipping and a context map FulfillmentMap. Use a customer/supplier relationship from customer Shipping to supplier Ordering. Put AntiCorruptionLayer on the customer endpoint. Put OpenHostService and PublishedLanguage on the supplier endpoint. Do not put either supplier pattern on the customer side or either customer pattern on the supplier side. Do not use semicolon terminators.',
            context
        );
        const features = featureScore(generated.code, [
            'customer Shipping', 'supplier Ordering', 'AntiCorruptionLayer',
            'OpenHostService', 'PublishedLanguage'
        ]);
        const wrongSideWarning = generated.warnings.some(warning =>
            warning.message.includes('not conventionally used')
        );
        return {
            ...generated.result.data,
            score: generated.valid && !wrongSideWarning ? features.score : 0,
            wrongSideWarning,
            ...features
        };
    });

    evaluation('uses a domain event locally and an integration event only in the consumer context', async (context: EvalContext) => {
        const generated = await generateAndValidate(
            'Generate a valid single-file Thinai model with producer bounded context Billing and consumer bounded context Shipping, connected by a partnership in a context map. In Billing, declare a domain event PaymentCaptured. Add a Billing application service that handles PaymentCaptured and emits a module-exposed integration event PaymentCapturedV1. In Shipping, add an application service that handles Billing.Contracts.PaymentCapturedV1. Do not handle the integration event inside Billing; same-context reactions must use the domain event. Do not use semicolon terminators.',
            context
        );
        const features = featureScore(generated.code, [
            'bounded context Billing', 'bounded context Shipping',
            'event PaymentCaptured', 'integration event PaymentCapturedV1',
            'source: Billing.Contracts.PaymentCapturedV1'
        ]);
        return {
            ...generated.result.data,
            score: generated.valid ? features.score : 0,
            ...features
        };
    });

    evaluation('keeps direct and projector-backed query repositories separate', async (context: EvalContext) => {
        const generated = await generateAndValidate(
            'Generate a valid single-file Thinai Ordering model. Declare aggregate Order with root entity Order and identifier id: OrderId, plus sibling value object OrderId. Declare read models OrderSummary and OrderLookup. Declare query repository OrderSummaryRepository that serves OrderSummary and has no reads from clause, maintained by a projector that handles the local OrderPlaced domain event and projects OrderSummary. Declare query repository OrderLookupRepository that serves OrderLookup and declares reads from Order. Declare a query service that reads from both repositories. Keep the two repository forms separate; do not put reads from and projector maintenance on the same repository. Do not use semicolon terminators.',
            context
        );
        const features = featureScore(generated.code, [
            'query repository OrderSummaryRepository', 'query repository OrderLookupRepository',
            'reads from Order', 'projector', 'projects OrderSummary', 'query service'
        ]);
        return {
            ...generated.result.data,
            score: generated.valid ? features.score : 0,
            ...features
        };
    });
});
