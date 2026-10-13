import { beforeEach, describe, evaluation } from 'langium-ai-tools/evals';
import { LangiumEvaluator } from 'langium-ai-tools/evaluator';
import type { EvalContext } from 'langium-ai-tools/evals';
import { EmptyFileSystem } from 'langium';
import { createThinaiServices } from '../packages/language/src/thinai-module.js';
import { extractCodeBlock, generateResponse } from './utils.js';

const services = createThinaiServices(EmptyFileSystem).Thinai;
const evaluator = new LangiumEvaluator(services);

async function generateAndEvaluate(prompt: string, context: EvalContext) {
    const response = await generateResponse(prompt, { systemPrompt: context.systemPrompt });
    const code = extractCodeBlock(response, 'thinai') ?? extractCodeBlock(response) ?? response;
    const result = await evaluator.evaluate(code);
    const diagnostics = result.data.diagnostics ?? [];
    const errors = diagnostics.filter(diagnostic => diagnostic.severity === 1);
    return {
        code,
        result,
        errors,
        valid: !result.data.failures && !result.data.errors && errors.length === 0,
        normalized: code.toLowerCase().replace(/\s+/g, ' ')
    };
}

describe('Thinai read-dependency evaluations', () => {
    beforeEach(async () => {
        await services.shared.workspace.WorkspaceManager.initializeWorkspace([]);
    });

    evaluation('models CQRS command and query repository dependencies', async (context: EvalContext) => {
        const generated = await generateAndEvaluate(
            'Generate valid single-file Thinai source for bounded context Ordering. Do not use semicolons; put each sibling statement on its own line. Declare aggregate Order with root entity Order, identifier id: OrderId, and method place(). Declare value object OrderId with raw: string. Declare repository OrderRepository in a block whose manages statement is Order.Order. Declare read model OrderSummary with orderId and status fields. Declare query repository OrderSummaryRepository in a block: it serves OrderSummary and reads directly from table data owned by aggregate Order (do not reference OrderRepository). Add application service OrderCommands with method placeOrder(id: OrderId) that reads from OrderRepository with a descriptive when guard, then invokes Order.Order.place. Add query service OrderQueries with method findOrder(id: OrderId) returning OrderSummary; it reads from OrderSummaryRepository. Use behavior prose to describe the data use, keep references valid, and follow CQRS repository boundaries.',
            context
        );
        const required = [
            'repository orderrepository',
            'manages order.order',
            'query repository ordersummaryrepository',
            'serves ordersummary',
            'reads from order',
            'reads from orderrepository when',
            'reads from ordersummaryrepository'
        ];
        const missing = required.filter(feature => !generated.normalized.includes(feature));
        return {
            score: generated.valid ? (required.length - missing.length) / required.length : 0,
            valid: generated.valid,
            missingFeatures: missing,
            errorCount: generated.errors.length,
            validationErrors: generated.errors.map(error => error.message),
            generatedCode: generated.valid ? undefined : generated.code,
            ...generated.result.data
        };
    });

    evaluation('models conditional domain-service and projector enrichment reads', async (context: EvalContext) => {
        const generated = await generateAndEvaluate(
            'Generate valid single-file Thinai source for bounded context Fulfillment. Put each non-empty block statement on its own line. Declare aggregate Customer with root entity Customer and identifier id: CustomerId; declare CustomerId with raw: string. Declare repository CustomerRepository managing Customer.Customer in a braced block. Declare event CustomerRegistered and read model CustomerSummary with customerId and displayName fields. Add domain service CustomerEligibility with method canFulfill(id: CustomerId) returning boolean; it reads from CustomerRepository only when a descriptive condition holds and its method-level behavior explains use of the retrieved customer. Add projector CustomerSummaryProjector with method onCustomerRegistered(source: CustomerRegistered); it reads from CustomerRepository under a descriptive when guard for enrichment, projects CustomerSummary, and describes the projection in method-level behavior. Do not add result aliases or a behavior clause nested inside reads from.',
            context
        );
        const required = [
            'domain service customereligibility',
            'reads from customerrepository when',
            'projector customersummaryprojector',
            'method oncustomerregistered(source: customerregistered)',
            'projects customersummary',
            'behavior '
        ];
        const missing = required.filter(feature => !generated.normalized.includes(feature));
        return {
            score: generated.valid ? (required.length - missing.length) / required.length : 0,
            valid: generated.valid,
            missingFeatures: missing,
            replayWarnings: generated.result.data.warnings ?? 0,
            errorCount: generated.errors.length,
            validationErrors: generated.errors.map(error => error.message),
            generatedCode: generated.valid ? undefined : generated.code,
            ...generated.result.data
        };
    });
});
