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
            'Generate a valid, single-file Thinai model for an Ordering bounded context. Declare root entity Order and value object OrderId as sibling members inside aggregate Order; never nest the value object in the entity. Give Order the field identifier id: OrderId; and OrderId the field raw: string;. Declare event OrderPlaced. Give Order a place method that emits OrderPlaced. Add application service OrderApplication for Order with method placeOrder that invokes Order.Order.place. Keep all declarations in the same file and make all references resolve.',
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
            'Generate a valid, single-file Thinai Ordering model. Use the structure root entity Order { constructor(id: OrderId) { invariant "A valid order has an identifier."; } method ensureOwner() { invariant "A valid order has an owner."; } method place() emits OrderPlaced; identifier id: OrderId; } followed by sibling declaration value object OrderId { raw: string; }. Do not put the value object inside the entity. Define application service OrderApplication for Order with method placeOrder invokes Order.Order.place { precondition "The order can be placed."; behavior "Check [[Order.Order.ensureOwner]] before placing."; postcondition "The order is placed."; }. Define event OrderPlaced;. Keep all references valid.',
            context
        );
        const lowerCode = generated.code.toLowerCase();
        const requiredFeatures = ['invariant', 'precondition', 'behavior', 'postcondition', 'ensureowner', '[['];
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
                root entity Order {
                    method ensureOwner() {
                        invariant "An order must have an owner; check [[Order.Order.ensureOwner]]";
                    }
                    identifier id: OrderId;
                }
                value object OrderId {
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
