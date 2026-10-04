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
            'Generate a valid, single-file Thinai model for an Ordering bounded context. Declare root entity Order and value object OrderId as sibling members inside aggregate Order; never nest the value object in the entity. Give Order the field identifier id: OrderId; and OrderId the field raw: string;. Declare event OrderPlaced. Give Order a place method whose body emits OrderPlaced. Declare repository OrderRepository for Order. Add application service OrderApplication with method placeOrder(id: OrderId) whose body optionally invokes Order.Order.place. Keep all declarations in the same file and make all references resolve.',
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
            'Generate a valid, single-file Thinai Ordering model. Use the structure root entity Order { constructor(id: OrderId) { invariant "A valid order has an identifier."; } method ensureOwner() { invariant "A valid order has an owner."; } method place() { emits OrderPlaced; } identifier id: OrderId; } followed by sibling declaration value object OrderId { raw: string; }. Do not put the value object inside the entity. Declare repository OrderRepository for Order. Define application service OrderApplication with method placeOrder(id: OrderId) { precondition "The order can be placed."; invokes Order.Order.place; behavior "Check [[Order.Order.ensureOwner]] before placing."; postcondition "The order is placed."; }. Define event OrderPlaced;. Keep all references valid.',
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

    evaluation('models DataObject inputs and results with descriptive Flow references', async (context: EvalContext) => {
        const generated = await evaluateGeneratedCode(
            'Generate a valid single-file Thinai Ordering model. Declare aggregate Order with root entity Order (identifier id: OrderId; method place();), value object OrderId { raw: string; }, and enum OrderStatus { Draft, Placed }. Declare repository OrderRepository for Order outside the aggregate. Declare nested identity-free data objects OrderLineInput { sku: string; quantity: number; }, PlaceOrderInput { orderId: OrderId; lines: List<OrderLineInput>; }, PlaceOrderResult { orderId: OrderId; status: OrderStatus; }, and EligibilityResult { eligible: boolean; }. Declare read model OrderSummary { orderId: OrderId; }, query repository OrderSummaryRepository serves OrderSummary, and query service OrderQueries with method checkEligibility(orderId: OrderId) returns EligibilityResult; its behavior specification may describe reading [[OrderSummaryRepository]] and returning [[result.eligible]]. Declare application service OrderCommands with method place(input: PlaceOrderInput) returns PlaceOrderResult { invokes Order.Order.place; behavior "Place [[input.orderId]] and return [[result.status]]."; }. Add flow PlaceOrder with actor Customer. Write the two Flow steps with the exact singular keyword syntax `invoke OrderCommands.place ...;` followed by `invoke OrderQueries.checkEligibility ...;` (never `invokes`). Put the `with` mapping and `when` guard on the same command-step statement, in that order, with only one terminating semicolon; link the local parameter [[input.orderId]], the relevant field [[OrderSummary.orderId]], and the query result [[Ordering.OrderQueries.checkEligibility.result.eligible]]. The query step appears after the command step to demonstrate descriptive, non-executable ordering. Do not use a reads clause, and ensure every reference resolves.',
            context
        );
        const lowerCode = generated.code.toLowerCase();
        const requiredFeatures = [
            'data object placeorderinput',
            'data object orderlineinput',
            'data object placeorderresult',
            'returns placeorderresult',
            'invokes order.order.place',
            '[[input.orderid]]',
            '[[result.status]]',
            '[[ordersummaryrepository]]',
            'with',
            'when',
            '[[ordering.orderqueries.checkeligibility.result.eligible]]'
        ];
        const missingFeatures = requiredFeatures.filter(feature => !lowerCode.includes(feature));
        const hasRemovedReadsClause = /\breads\s+[A-Z_]/.test(generated.code);
        const flowOrderIsDescriptive = generated.code.indexOf('invoke OrderCommands.place') >= 0 &&
            generated.code.indexOf('invoke OrderCommands.place') < generated.code.indexOf('invoke OrderQueries.checkEligibility');
        const featureScore = (requiredFeatures.length - missingFeatures.length + (hasRemovedReadsClause ? 0 : 1)) /
            (requiredFeatures.length + 1);
        return {
            score: generated.valid ? featureScore * (flowOrderIsDescriptive ? 1 : 0.5) : 0,
            valid: generated.valid,
            featureScore,
            missingFeatures,
            hasRemovedReadsClause,
            flowOrderIsDescriptive,
            generatedCode: generated.code,
            errorCount: generated.errors.length,
            validationErrors: generated.errors.map(error => error.message),
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
        const plainExplanation = explanation.replace(/[*_`]/g, '');
        const lowerExplanation = plainExplanation.toLowerCase();
        const expectedConcepts = ['order', 'owner', 'ensureowner'];
        const matchedConcepts = expectedConcepts.filter(concept => lowerExplanation.includes(concept));
        return {
            score: matchedConcepts.length / expectedConcepts.length,
            matchedConcepts,
            expectedConcepts
        };
    });

    evaluation('understands DataObjects and descriptive Flow text', async (context: EvalContext) => {
        const explanation = await generateResponse(
            'In plain English, explain the difference between a value object and a DataObject used as a command input. Explain that Flow with/when text is descriptive rather than executable. A when clause may link to the result of a query that is declared in the model but is not invoked by that Flow, or is invoked later; explicitly state whether Thinai requires that query to appear or execute earlier. Do not impose an ordering requirement.',
            { systemPrompt: context.systemPrompt }
        );
        const plainExplanation = explanation.replace(/[*_`]/g, '');
        const lowerExplanation = plainExplanation.toLowerCase();
        const expectedConcepts = [
            { name: 'DataObject input shape', alternatives: ['data object', 'input'] },
            { name: 'value object is a domain concept', alternatives: ['value object'] },
            { name: 'Flow text is descriptive', alternatives: ['descriptive', 'not executable', 'does not execute'] },
            { name: 'query reference has no ordering requirement', alternatives: [] }
        ];
        const queryOrderIsOptional = /\b(?:not required|need not|needn't|does not require|doesn't require|does not need|doesn't need|not necessary|no requirement|without requiring|does not have to|doesn't have to)\b.{0,180}\b(?:earlier|before|prior|precede|appear|occur|invoke|execute)\b/i.test(plainExplanation) ||
            /\bno\s+(?:execution\s+)?(?:ordering|sequence)\s+(?:requirement|constraint)\b/i.test(plainExplanation);
        const matchedConcepts = expectedConcepts.filter(concept => concept.alternatives.some(alternative =>
            lowerExplanation.includes(alternative)
        ));
        if (queryOrderIsOptional) {
            matchedConcepts.push(expectedConcepts[3]);
        }
        return {
            score: matchedConcepts.length / expectedConcepts.length,
            matchedConcepts: matchedConcepts.map(concept => concept.name),
            missingConcepts: expectedConcepts.filter(concept => !matchedConcepts.includes(concept)).map(concept => concept.name),
            expectedConcepts: expectedConcepts.length,
            explanation
        };
    });

    evaluation('understands imports, modules, and bounded-context boundaries', async (context: EvalContext) => {
        const explanation = await generateResponse(
            'In plain English, explain these Thinai rules: imports are direct and relative; when a file imports multiple components it selects them and may alias a selected component; a `part of bounded context` file must directly import the canonical context; module references require both dependency and exposure; and only IntegrationEvents may cross bounded-context boundaries, with an authorized imported context map. Explain that DomainEvents stay private.',
            { systemPrompt: context.systemPrompt }
        );
        const normalized = explanation.replace(/[*_`]/g, '').toLowerCase();
        const expectedConcepts = [
            ['relative', 'direct import'],
            ['select', 'component selector'],
            ['alias'],
            ['part of', 'canonical context'],
            ['dependency', 'depends'],
            ['exposure', 'expose', 'exposes'],
            ['integrationevent'],
            ['authorized', 'context map'],
            ['domainevent', 'private']
        ];
        const matchedConcepts = expectedConcepts.filter(concept =>
            concept.some(keyword => normalized.includes(keyword))
        );
        return {
            score: matchedConcepts.length / expectedConcepts.length,
            matchedConceptCount: matchedConcepts.length,
            totalConcepts: expectedConcepts.length,
            missingConcepts: expectedConcepts.filter(concept => !concept.some(keyword => normalized.includes(keyword)))
                .map(concept => concept[0]),
            explanation
        };
    });
});
