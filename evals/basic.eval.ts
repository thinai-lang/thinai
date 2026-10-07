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
            'Generate a valid, single-file Thinai model for an Ordering bounded context. Use no semicolon terminators. Put every sibling declaration and statement on its own line, including inside braces. Declare aggregate Order with root entity Order and sibling value object OrderId. Give Order the identifier field id: OrderId and give OrderId the field raw: string. Declare event OrderPlaced. Give Order a place method whose body emits OrderPlaced. Declare repository OrderRepository manages Order.Order. Add application service OrderApplication with method placeOrder(id: OrderId) whose body optionally invokes Order.Order.place. Keep all declarations in the same file and make all references resolve.',
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
            'Generate a valid, single-file Thinai Ordering model. Use no semicolon terminators and put each sibling declaration or body statement on its own line. Declare root entity Order inside aggregate Order. Its constructor takes id: OrderId and has invariant "A valid order has an identifier.". Add method ensureOwner() with invariant "A valid order has an owner." and method place() that emits OrderPlaced. Give Order the identifier field id: OrderId. Declare value object OrderId as a sibling with raw: string, event OrderPlaced, and repository OrderRepository manages Order.Order. Define application service OrderApplication with method placeOrder(id: OrderId) containing precondition "The order can be placed.", invokes Order.Order.place when "The order is ready to be placed.", behavior "Check [[Order.Order.ensureOwner]] before placing.", and postcondition "The order is placed.". Keep all references valid and describe the invocation guard as prose, not executable logic.',
            context
        );
        const lowerCode = generated.code.toLowerCase();
        const requiredFeatures = ['invariant', 'precondition', 'behavior', 'postcondition', 'ensureowner', '[['];
        const featureScore = requiredFeatures.filter(feature => lowerCode.includes(feature)).length / requiredFeatures.length;
        const hasGuardedInvocation = /invokes\s+order\.order\.place\s+when\s+"[^"]+"/.test(lowerCode);
        const score = generated.valid ? featureScore * (hasGuardedInvocation ? 1 : 0.5) : 0;
        return {
            score,
            valid: generated.valid,
            featureScore,
            hasGuardedInvocation,
            missingFeatures: requiredFeatures.filter(feature => !lowerCode.includes(feature)),
            errorCount: generated.errors.length,
            ...generated.result.data
        };
    });

    evaluation('models DataObject inputs and results with descriptive Journey references', async (context: EvalContext) => {
        const generated = await evaluateGeneratedCode(
            'Generate a valid single-file Thinai Ordering model. Use no semicolon terminators and put each sibling declaration and body statement on its own line. Declare aggregate Order with root entity Order containing identifier id: OrderId and method place(), followed by sibling value object OrderId { raw: string } and enum OrderStatus { Draft, Placed }. Declare repository OrderRepository manages Order.Order outside the aggregate. Declare identity-free data objects OrderLineInput with sku and quantity fields, PlaceOrderInput with orderId: OrderId and lines: List<OrderLineInput>, PlaceOrderResult with orderId: OrderId and status: OrderStatus, and EligibilityResult with eligible: boolean. Declare read model OrderSummary with orderId: OrderId, query repository OrderSummaryRepository serves OrderSummary, and query service OrderQueries with method checkEligibility(orderId: OrderId) returns EligibilityResult; its behavior may describe reading [[OrderSummaryRepository]] and returning [[result.eligible]]. Declare application service OrderCommands with method place(input: PlaceOrderInput) returns PlaceOrderResult. Its body invokes Order.Order.place and describes placing [[input.orderId]] and returning [[result.status]]. Declare actor Customer on its own line. Add top-level journey PlaceOrder with `by Customer { ... }` and one user-invoked command step `invoke Ordering.OrderCommands.place`. Put descriptive `with` mapping and `when` guard on that same command step, link [[input.orderId]], [[Ordering.OrderSummary.orderId]], and [[Ordering.OrderQueries.checkEligibility.result.eligible]], and do not invoke the query or add event handoff steps to the journey. A query result may be linked descriptively without requiring a query step or ordering requirement. Do not use a reads clause, and ensure all references resolve.',
            context
        );
        const lowerCode = generated.code.toLowerCase();
        const requiredFeatures = [
            'data object placeorderinput',
            'data object orderlineinput',
            'data object placeorderresult',
            'returns placeorderresult',
            'journey placeorder',
            'by customer',
            'invoke ordering.ordercommands.place',
            '[[input.orderid]]',
            '[[result.status]]',
            '[[ordersummaryrepository]]',
            'with',
            'when',
            '[[ordering.orderqueries.checkeligibility.result.eligible]]'
        ];
        const missingFeatures = requiredFeatures.filter(feature => !lowerCode.includes(feature));
        const hasRemovedReadsClause = /\breads\s+[A-Z_]/.test(generated.code);
        const journeyIsDescriptive = generated.code.includes('journey PlaceOrder') &&
            generated.code.includes('by Customer') &&
            generated.code.includes('invoke Ordering.OrderCommands.place') &&
            !generated.code.includes('invoke OrderQueries.checkEligibility');
        const featureScore = (requiredFeatures.length - missingFeatures.length + (hasRemovedReadsClause ? 0 : 1)) /
            (requiredFeatures.length + 1);
        return {
            score: generated.valid ? featureScore * (journeyIsDescriptive ? 1 : 0.5) : 0,
            valid: generated.valid,
            featureScore,
            missingFeatures,
            hasRemovedReadsClause,
            journeyIsDescriptive,
            generatedCode: generated.code,
            errorCount: generated.errors.length,
            validationErrors: generated.errors.map(error => error.message),
            ...generated.result.data
        };
    });
});

describe('Thinai understanding evaluations', () => {
    evaluation('explains a behavior specification and its method reference', async (context: EvalContext) => {
        const source = `bounded context Ordering
        in bounded context Ordering {
            aggregate Order {
                root entity Order {
                    method ensureOwner() {
                        invariant "An order must have an owner; check [[Order.Order.ensureOwner]]"
                    }
                    identifier id: OrderId
                }
                value object OrderId {
                    raw: string
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

    evaluation('understands DataObjects and descriptive Journey text', async (context: EvalContext) => {
        const explanation = await generateResponse(
            'In plain English, explain the difference between a value object and a DataObject used as a command input. Explain that Journey with/when text is descriptive rather than executable and a Journey may describe user commands across bounded contexts. A when clause may link to the result of a query declared in the model without invoking that query in the Journey; explicitly state that Thinai does not require the query to appear or execute earlier. Explain that background event handoffs remain represented by event declarations and handlers, not Journey steps.',
            { systemPrompt: context.systemPrompt }
        );
        const plainExplanation = explanation.replace(/[*_`]/g, '');
        const lowerExplanation = plainExplanation.toLowerCase();
        const expectedConcepts = [
            { name: 'DataObject input shape', alternatives: ['data object', 'input'] },
            { name: 'value object is a domain concept', alternatives: ['value object'] },
            { name: 'Journey text is descriptive', alternatives: ['descriptive', 'not executable', 'does not execute'] },
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
            'In plain English, explain these Thinai rules: imports are direct and relative; when a file imports multiple components it selects them and may alias a selected component; an `in bounded context` contribution must directly import the canonical bounded-context declaration; module references require both dependency and exposure; and only IntegrationEvents may cross bounded-context boundaries, with an authorized imported context map. Explain that DomainEvents stay private.',
            { systemPrompt: context.systemPrompt }
        );
        const normalized = explanation.replace(/[*_`]/g, '').toLowerCase();
        const expectedConcepts = [
            ['relative', 'direct import'],
            ['select', 'component selector'],
            ['alias'],
            ['in bounded context', 'canonical context'],
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
