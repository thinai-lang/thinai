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
    return { code, result, errors, valid: !result.data.failures && !result.data.errors && errors.length === 0 };
}

function featureScore(code: string, required: string[]): { score: number; missing: string[] } {
    const normalized = code.toLowerCase().replace(/\s+/g, ' ');
    const missing = required.filter(feature => !normalized.includes(feature.toLowerCase()));
    return { score: (required.length - missing.length) / required.length, missing };
}

describe('Thinai language concept evaluations', () => {
    beforeEach(async () => {
        await services.shared.workspace.WorkspaceManager.initializeWorkspace([]);
    });

    evaluation('models strategic context and shared-kernel structures', async (context: EvalContext) => {
        const generated = await generateAndValidate(
            'Generate a valid single-file Thinai model. Write subdomain declarations exactly as `subdomain Commerce kind core;` and `subdomain Fulfillment kind supporting;`—do not omit the `kind` keyword. Declare bounded contexts Ordering realizes Commerce, Shipping realizes Fulfillment, and Returns realizes Fulfillment. Add shared kernel CommonTypes with value object CorrelationId { raw: string; }, enum Priority { Normal, Urgent }, and an empty module SharedContracts { }. In Ordering, add module CoreTypes { exposes OrderReference; value object OrderReference { raw: string; } } and sibling module ApiTypes depends on CoreTypes { data object OrderRequest { reference: OrderReference; priority: Priority; } }. Add context map CommerceMap containing all four relationship forms: customer Ordering { integrationPatterns: ["AntiCorruptionLayer"] } -> supplier Shipping { integrationPatterns: ["PublishedLanguage"] }; partner Ordering <-> partner Returns; separateWays Shipping -x- Returns; and sharedKernel CommonTypes { participants: [Ordering, Shipping] }. Use exactly these module braces and in-module exposure syntax, and keep every reference valid.',
            context
        );
        const features = featureScore(generated.code, [
            'subdomain Commerce kind core', 'realizes Commerce', 'shared kernel CommonTypes',
            'participants: [Ordering, Shipping]', 'customer Ordering', 'supplier Shipping',
            'partner Ordering <-> partner Returns', 'separateWays Shipping -x- Returns',
            'AntiCorruptionLayer', 'PublishedLanguage', 'module ApiTypes depends on CoreTypes',
            'exposes OrderReference', 'data object OrderRequest'
        ]);
        return {
            score: generated.valid ? features.score : 0,
            valid: generated.valid,
            featureScore: features.score,
            missingFeatures: features.missing,
            diagnostics: generated.errors.map(error => error.message),
            generatedCode: generated.valid ? undefined : generated.code,
            ...generated.result.data
        };
    });

    evaluation('models aggregate identity, state, inheritance, mirroring, and creation', async (context: EvalContext) => {
        const generated = await generateAndValidate(
            'Generate a valid single-file Thinai model. Declare subdomain Commerce kind core and context Catalog realizing Commerce with aggregate Product whose root entity Product has identifier id: ProductId; declare sibling value object ProductId { raw: string; }. Declare bounded context Ordering realizing Commerce. Inside aggregate Order, declare root entity Order with method place() whose body emits OrderPlaced and transitions status from Draft to Placed; then declare identifier id: OrderId and status: OrderStatus initial Draft as fields after the method. Declare entity OrderLine with method ship() that transitions status from Open to Shipped; then declare identifier id: OrderLineId and field status: LineStatus initial Open. Declare OrderLineId and OrderId value objects in Order. Add entity SpecialOrderLine extends OrderLine with its own identifier specialId: SpecialOrderLineId, and declare that ID value object. Do not write a `child` keyword before entity declarations. Add enum types OrderStatus { Draft, Placed } and LineStatus { Open, Shipped }. Declare the mirror using the exact syntax `value object CatalogProductId mirrors Catalog.Product.ProductId { raw: string; }`, then use CatalogProductId as OrderLine.productId. Declare repository OrderRepository for Order and factory OrderFactory for Order operations { method createOrder() returns Order; }. Add application service OrderCommands for Order with method createOrder() { invokes Order.OrderFactory.createOrder; }. Include aggregate invariant text and keep references valid.',
            context
        );
        const features = featureScore(generated.code, [
            'aggregate Order', 'root entity Order', 'entity SpecialOrderLine extends OrderLine',
            'mirrors Catalog.Product.ProductId', 'initial Draft', 'transition status from Draft to Placed',
            'invariant', 'factory OrderFactory', 'returns Order', 'invokes Order.OrderFactory.createOrder',
            'method createOrder()'
        ]);
        return {
            score: generated.valid ? features.score : 0,
            valid: generated.valid,
            featureScore: features.score,
            missingFeatures: features.missing,
            diagnostics: generated.errors.map(error => error.message),
            generatedCode: generated.valid ? undefined : generated.code,
            ...generated.result.data
        };
    });

    evaluation('models event publication, projections, and query repository prose', async (context: EvalContext) => {
        const generated = await generateAndValidate(
            'Generate a valid single-file Thinai Ordering bounded context. Declare aggregate Order with root entity Order { method place() { emits OrderPlaced; } identifier id: OrderId; }, sibling value object OrderId { raw: string; }, and repository OrderRepository for Order. Declare DomainEvent OrderPlaced data { orderId: OrderId; status: string; }. Declare module Contracts { exposes OrderPlacedV1; integration event OrderPlacedV1 data { orderId: string; status: string; } }. Declare read model OrderSummary { orderId: string; status: string; }, query repository OrderSummaryRepository for OrderSummary, and projector OrderSummaryProjector for OrderSummary with method onOrderPlaced(source: event OrderPlaced) whose behavior links OrderPlaced.orderId and OrderSummary.orderId and may mention [[OrderSummaryRepository]]. Add application service OrderApplication for Order with method placeOrder(id: OrderId) { invokes Order.Order.place; } and method publish(source: event OrderPlaced) { emits Contracts.OrderPlacedV1; behavior "Map the internal event to the contract."; }. Add query service OrderQueries with method search() returns List<OrderSummary> whose behavior specification links [[OrderSummaryRepository]]. Ensure all references resolve.',
            context
        );
        const features = featureScore(generated.code, [
            'event OrderPlaced data', 'integration event OrderPlacedV1 data', 'exposes OrderPlacedV1',
            'emits OrderPlaced;', 'source: event OrderPlaced',
            'emits Contracts.OrderPlacedV1;', 'returns List<OrderSummary>',
            '[[OrderSummaryRepository]]'
        ]);
        const hasReadsClause = /\breads\s+[A-Z_]/.test(generated.code);
        const score = generated.valid && !hasReadsClause ? features.score : 0;
        return {
            score,
            valid: generated.valid,
            featureScore: features.score,
            missingFeatures: features.missing,
            hasReadsClause,
            diagnostics: generated.errors.map(error => error.message),
            generatedCode: generated.valid ? undefined : generated.code,
            ...generated.result.data
        };
    });

    evaluation('models optional fields, collection types, capabilities, and domain services', async (context: EvalContext) => {
        const generated = await generateAndValidate(
            'Generate a valid single-file Thinai Inventory bounded context. Declare capability StockControl;. Declare aggregate Stock with root entity Stock { identifier id: StockId; quantities: Map<string, number>; labels: Set<string>; }, sibling value object StockId { raw: string; }, and enum StockState { Available, Reserved }. Declare data object StockSearch { sku?: string; warehouseIds: List<string>; filters: Map<string, List<string>>; }. Add domain service AvailabilityPolicy with method canReserve(stockId: StockId, request: StockSearch) returns boolean whose behavior explains the reservation rule. Keep every declaration at its grammar-defined scope, use `?` only for optional fields, and ensure all references resolve.',
            context
        );
        const features = featureScore(generated.code, [
            'capability StockControl', 'domain service AvailabilityPolicy', 'returns boolean',
            'sku?: string', 'Set<string>', 'Map<string, number>',
            'Map<string, List<string>>', 'warehouseIds: List<string>', 'data object StockSearch'
        ]);
        return {
            score: generated.valid ? features.score : 0,
            valid: generated.valid,
            featureScore: features.score,
            missingFeatures: features.missing,
            diagnostics: generated.errors.map(error => error.message),
            generatedCode: generated.valid ? undefined : generated.code,
            ...generated.result.data
        };
    });
});
