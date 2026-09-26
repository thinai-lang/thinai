import { describe, evaluation, beforeEach } from 'langium-ai-tools/evals';
import { LangiumEvaluator } from 'langium-ai-tools/evaluator';
import type { EvalContext } from 'langium-ai-tools/evals';
import { EmptyFileSystem } from 'langium';
import { createThinaiServices } from '../packages/language/src/thinai-module.js';
import { extractCodeBlock, generateResponse } from './utils.js';

const thinaiServices = createThinaiServices(EmptyFileSystem).Thinai;
const evaluator = new LangiumEvaluator(thinaiServices);

async function evaluateGeneratedCode(prompt: string, context: EvalContext) {
    const response = await generateResponse(prompt, { systemPrompt: context.systemPrompt });
    const code = extractCodeBlock(response) ?? response;
    const result = await evaluator.evaluate(code);
    const diagnostics = result.data.diagnostics ?? [];
    const errors = diagnostics.filter(diagnostic => diagnostic.severity === 1);
    const valid = !result.data.failures && !result.data.errors && errors.length === 0;
    return { code, result, diagnostics, errors, valid };
}

describe('Thinai generation evaluations', () => {
    beforeEach(async () => {
        await thinaiServices.shared.workspace.WorkspaceManager.initializeWorkspace([]);
    });

    evaluation('generates a valid single-file ordering model', async (context: EvalContext) => {
        const generated = await evaluateGeneratedCode(
            'Generate a valid, single-file Thinai model for an Ordering bounded context. Declare root entity OrderRoot and identifier value object OrderId for OrderRoot as sibling members inside aggregate Order; never nest the value object in the entity. Give OrderRoot the field identifier id: OrderId; and OrderId the field raw: string;. Define the command as command PlaceOrder targets Order emits OrderPlaced; and the event as event OrderPlaced caused by PlaceOrder for Order;. Do not separate command or event clauses with semicolons. Keep all declarations in the same file and make all references resolve.',
            context
        );
        return {
            score: generated.valid ? 1 : 0,
            valid: generated.valid,
            errorCount: generated.errors.length,
            ...generated.result.data
        };
    });

    evaluation('uses linked behavior specifications for command logic', async (context: EvalContext) => {
        const generated = await evaluateGeneratedCode(
            'Generate a valid, single-file Thinai Ordering model. Use the exact structure root entity OrderRoot operations { method ensureOwner(); } { identifier id: OrderId; invariant $"A valid order has an owner; check ${OrderRoot.ensureOwner}."; } followed by sibling declaration identifier value object OrderId for OrderRoot { raw: string; }. Do not put the value object inside the entity. Define command PlaceOrder targets Order emits OrderPlaced { invariant "A placed order has an owner."; precondition "The order can be placed."; behavior $"Check ${Order.OrderRoot.ensureOwner} before placing."; postcondition "OrderPlaced is emitted."; }. Define event OrderPlaced caused by PlaceOrder for Order;. Keep command clauses in keyword order with no semicolons between clauses.',
            context
        );
        const lowerCode = generated.code.toLowerCase();
        const requiredFeatures = ['invariant', 'precondition', 'behavior', 'postcondition', 'ensureowner', '${'];
        const featureScore = requiredFeatures.filter(feature => lowerCode.includes(feature)).length / requiredFeatures.length;
        const score = generated.valid ? featureScore : 0;
        return {
            score,
            valid: generated.valid,
            featureScore,
            missingFeatures: requiredFeatures.filter(feature => !lowerCode.includes(feature)),
            errorCount: generated.errors.length,
            ...generated.result.data
        };
    });
});

describe('Thinai understanding evaluations', () => {
    evaluation('explains a behavior specification and its method reference', async (context: EvalContext) => {
        const source = `bounded context Ordering {
            aggregate Order {
                root entity OrderRoot operations {
                    method ensureOwner();
                } {
                    identifier id: OrderId;
                    invariant $"An order must have an owner; check ${'${OrderRoot.ensureOwner}'}";
                }
                identifier value object OrderId for OrderRoot {
                    raw: string;
                }
            }
        }`;
        const explanation = await generateResponse(
            `Explain what the following Thinai model states, including the invariant and what its inline method reference points to:\n\n\`\`\`thinai\n${source}\n\`\`\``,
            { systemPrompt: context.systemPrompt }
        );
        const lowerExplanation = explanation.toLowerCase();
        const expectedConcepts = ['order', 'owner', 'ensureowner'];
        const matchedConcepts = expectedConcepts.filter(concept => lowerExplanation.includes(concept));
        return {
            score: matchedConcepts.length / expectedConcepts.length,
            matchedConcepts,
            expectedConcepts
        };
    });
});
