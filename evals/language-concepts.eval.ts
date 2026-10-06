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
            'Generate a valid single-file Thinai model. Write subdomain declarations exactly as `subdomain Commerce kind core;` and `subdomain Fulfillment kind supporting;`—do not omit the `kind` keyword. Declare bounded contexts without braces, then put each context’s members in a separate `in bounded context Name { ... }` block: Ordering realizes Commerce, Shipping realizes Fulfillment, and Returns realizes Fulfillment. Add shared kernel CommonTypes with value object CorrelationId { raw: string; }, enum Priority { Normal, Urgent }, and an empty module SharedContracts { }. In Ordering, add module CoreTypes { exposes OrderReference; value object OrderReference { raw: string; } } and sibling module ApiTypes depends on CoreTypes { data object OrderRequest { reference: OrderReference; priority: Priority; } }. Add context map CommerceMap containing all four relationship forms: customer Ordering { integrationPatterns: ["AntiCorruptionLayer"] } -> supplier Shipping { integrationPatterns: ["PublishedLanguage"] }; partner Ordering <-> partner Returns; separateWays Shipping -x- Returns; and sharedKernel CommonTypes { participants: [Ordering, Shipping] }. Use exactly these module braces and in-module exposure syntax, and keep every reference valid.',
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
            ...generated.result.data,
            score: generated.valid ? features.score : 0,
            valid: generated.valid,
            featureScore: features.score,
            missingFeatures: features.missing,
            diagnostics: generated.errors.map(error => error.message),
            generatedCode: generated.valid ? undefined : generated.code
        };
    });

    evaluation('models aggregate identity, state, inheritance, mirroring, and creation', async (context: EvalContext) => {
        const generated = await generateAndValidate(
            'Generate a valid single-file Thinai model. Declare each bounded context without braces, then put its members in a separate `in bounded context Name { ... }` block. Declare subdomain Commerce kind core and context Catalog realizing Commerce with aggregate Product whose root entity Product has identifier id: ProductId; declare sibling value object ProductId { raw: string; }. Declare bounded context Ordering realizing Commerce. Inside aggregate Order, declare root entity Order with method place() whose body emits OrderPlaced and transitions status from Draft to Placed; then declare identifier id: OrderId and status: OrderStatus initial Draft as fields after the method. Declare entity OrderLine with method ship() that transitions status from Open to Shipped; then declare identifier id: OrderLineId and field status: LineStatus initial Open. Declare OrderLineId and OrderId value objects in Order. Add entity SpecialOrderLine extends OrderLine with its own identifier specialId: SpecialOrderLineId, and declare that ID value object. Do not write a `child` keyword before entity declarations. Add enum types OrderStatus { Draft, Placed } and LineStatus { Open, Shipped }. Declare the mirror using the exact syntax `value object CatalogProductId mirrors Catalog.Product.ProductId { raw: string; }`, then use CatalogProductId as OrderLine.productId. Outside the aggregate, declare repository OrderRepository manages Order.Order and factory OrderFactory with method createOrder() returns Order.Order. Add application service OrderCommands with method createOrder() { invokes OrderFactory.createOrder; }. Include aggregate invariant text and keep references valid.',
            context
        );
        const features = featureScore(generated.code, [
            'aggregate Order', 'root entity Order', 'entity SpecialOrderLine extends OrderLine',
            'mirrors Catalog.Product.ProductId', 'initial Draft', 'transition status from Draft to Placed',
            'invariant', 'factory OrderFactory', 'returns Order.Order', 'invokes OrderFactory.createOrder',
            'method createOrder()'
        ]);
        return {
            ...generated.result.data,
            score: generated.valid ? features.score : 0,
            valid: generated.valid,
            featureScore: features.score,
            missingFeatures: features.missing,
            diagnostics: generated.errors.map(error => error.message),
            generatedCode: generated.valid ? undefined : generated.code
        };
    });

    evaluation('models guarded emissions and grouped conditional transitions', async (context: EvalContext) => {
        const generated = await generateAndValidate(
            'Generate a valid single-file Thinai Ordering bounded context. Declare aggregate Order with root entity Order. Give it method place() with transition status from Draft to Placed. Give it method pay() with one grouped transition statement changing status from Placed to Paid and paymentStatus from Pending to Confirmed, followed by one shared descriptive when guard saying payment has been accepted. In the same method, emit OrderPaid and PaymentRecorded in one emits clause with a descriptive when guard. Add fields identifier id: OrderId, status: OrderStatus initial Draft, and paymentStatus: PaymentStatus initial Pending. Declare OrderId as a sibling value object with raw: string, OrderStatus { Draft, Placed, Paid }, PaymentStatus { Pending, Confirmed }, and both events. Do not use semicolon terminators. Keep all references valid, and do not describe the guards as executable conditions.',
            context
        );
        const normalized = generated.code.toLowerCase().replace(/\s+/g, ' ');
        const features = featureScore(generated.code, [
            'paymentStatus: PaymentStatus initial Pending',
            'emits OrderPaid, PaymentRecorded',
            'when',
            'OrderStatus',
            'PaymentStatus'
        ]);
        const hasGroupedTransition = /transition\s+status\s+from\s+placed\s+to\s+paid\s*,\s*paymentstatus\s+from\s+pending\s+to\s+confirmed\s+when/.test(normalized);
        const hasGuardedEmission = /emits\s+orderpaid\s*,\s*paymentrecorded\s+when/.test(normalized);
        const score = generated.valid
            ? (features.score + Number(hasGroupedTransition) + Number(hasGuardedEmission)) / 3
            : 0;
        return {
            ...generated.result.data,
            score,
            valid: generated.valid,
            featureScore: features.score,
            missingFeatures: features.missing,
            hasGroupedTransition,
            hasGuardedEmission,
            diagnostics: generated.errors.map(error => error.message),
            generatedCode: generated.valid ? undefined : generated.code
        };
    });

    evaluation('models a descriptive guard on a method invocation', async (context: EvalContext) => {
        const generated = await generateAndValidate(
            'Generate a valid single-file Thinai Ordering bounded context. Declare aggregate Order with root entity Order. Give Order the field identifier id: OrderId and status: OrderStatus initial Draft, and methods place() and ensureOwner(). Add enum OrderStatus { Draft, Placed } and sibling value object OrderId { raw: string; }. Add application service OrderApplication with method placeOrder() whose body invokes Order.Order.place with a descriptive when guard saying the order is ready to be placed. Make the guard explicit after the fully qualified invocation target, and do not describe it as executable or as bypassing invocation rules.',
            context
        );
        const normalized = generated.code.toLowerCase().replace(/\s+/g, ' ');
        const hasGuardedInvocation = /invokes\s+order\.order\.place\s+when\s+"[^"]+"/.test(normalized);
        return {
            ...generated.result.data,
            score: generated.valid && hasGuardedInvocation ? 1 : 0,
            valid: generated.valid,
            hasGuardedInvocation,
            diagnostics: generated.errors.map(error => error.message),
            generatedCode: generated.valid ? undefined : generated.code
        };
    });

    evaluation('keeps constructor inputs in the domain model and DataObjects at the service boundary', async (context: EvalContext) => {
        const generated = await generateAndValidate(
            'Generate a valid single-file Thinai Ordering bounded context. Declare aggregate Order with root entity Order and constructor(id: OrderId, details: OrderDetails). Give Order the identifier field id: OrderId. Declare sibling value object OrderId with raw: string and value object OrderDetails with address: string. Declare data object PlaceOrderInput with orderId: OrderId and deliveryAddress: string, then define application service OrderApplication with method placeOrder(input: PlaceOrderInput). Constructors must take domain values, never a DataObject or an event; keep the request DataObject as the application-service input. Do not use semicolon terminators and ensure all references resolve.',
            context
        );
        const normalized = generated.code.toLowerCase().replace(/\s+/g, ' ');
        const features = featureScore(generated.code, [
            'constructor(id: OrderId, details: OrderDetails)',
            'data object PlaceOrderInput',
            'method placeOrder(input: PlaceOrderInput)',
            'value object OrderDetails',
            'identifier id: OrderId'
        ]);
        const constructorUsesDataObject = /constructor\s*\([^)]*\bplaceorderinput\b/.test(normalized);
        const hasValidBoundary = /method\s+placeorder\s*\(\s*input:\s*placeorderinput\s*\)/.test(normalized) && !constructorUsesDataObject;
        const score = generated.valid ? (features.score + Number(hasValidBoundary)) / 2 : 0;
        return {
            ...generated.result.data,
            score,
            valid: generated.valid,
            featureScore: features.score,
            missingFeatures: features.missing,
            constructorUsesDataObject,
            hasValidBoundary,
            diagnostics: generated.errors.map(error => error.message),
            generatedCode: generated.valid ? undefined : generated.code
        };
    });

    evaluation('models event publication, projections, and query repository prose', async (context: EvalContext) => {
        const generated = await generateAndValidate(
            'Generate a valid single-file Thinai Ordering bounded context. Declare aggregate Order with root entity Order { method place() { emits OrderPlaced; } identifier id: OrderId; }, and sibling value object OrderId { raw: string; }. Declare repository OrderRepository manages Order.Order outside the aggregate. Declare event OrderPlaced { orderId: string; status: string; }. Declare module Contracts { exposes OrderPlacedV1; integration event OrderPlacedV1 { orderId: string; status: string; } }. Declare read model OrderSummary { orderId: string; status: string; }, query repository OrderSummaryRepository serves OrderSummary, and projector OrderSummaryProjector with method onOrderPlaced(source: OrderPlaced) whose body declares `projects OrderSummary;` and behavior links OrderPlaced.orderId and OrderSummary.orderId and may mention [[OrderSummaryRepository]]. Add application service OrderApplication with method placeOrder(id: OrderId) { invokes Order.Order.place; } and method publish(source: OrderPlaced) { emits Contracts.OrderPlacedV1; behavior "Map the internal event to the contract."; }. Add query service OrderQueries with method search() returns List<OrderSummary> whose behavior specification links [[OrderSummaryRepository]]. Ensure all references resolve.',
            context
        );
        const features = featureScore(generated.code, [
            'event OrderPlaced {', 'integration event OrderPlacedV1 {', 'exposes OrderPlacedV1',
            'emits OrderPlaced;', 'source: OrderPlaced',
            'emits Contracts.OrderPlacedV1;', 'returns List<OrderSummary>',
            '[[OrderSummaryRepository]]'
        ]);
        const hasReadsClause = /\breads\s+[A-Z_]/.test(generated.code);
        const score = generated.valid && !hasReadsClause ? features.score : 0;
        return {
            ...generated.result.data,
            score,
            valid: generated.valid,
            featureScore: features.score,
            missingFeatures: features.missing,
            hasReadsClause,
            diagnostics: generated.errors.map(error => error.message),
            generatedCode: generated.valid ? undefined : generated.code
        };
    });

    evaluation('models optional fields, collection types, and domain services', async (context: EvalContext) => {
        const generated = await generateAndValidate(
            'Generate a valid single-file Thinai Inventory bounded context. Declare aggregate Stock with root entity Stock { identifier id: StockId; quantities: Map<string, number>; labels: Set<string>; }, sibling value object StockId { raw: string; }, and enum StockState { Available, Reserved }. Declare data object StockSearch { sku?: string; warehouseIds: List<string>; filters: Map<string, List<string>>; }. Add domain service AvailabilityPolicy with method canReserve(stockId: StockId, request: StockSearch) returns boolean whose behavior explains the reservation rule. Keep every declaration at its grammar-defined scope, use `?` only for optional fields, and ensure all references resolve.',
            context
        );
        const features = featureScore(generated.code, [
            'domain service AvailabilityPolicy', 'returns boolean',
            'sku?: string', 'Set<string>', 'Map<string, number>',
            'Map<string, List<string>>', 'warehouseIds: List<string>', 'data object StockSearch'
        ]);
        return {
            ...generated.result.data,
            score: generated.valid ? features.score : 0,
            valid: generated.valid,
            featureScore: features.score,
            missingFeatures: features.missing,
            diagnostics: generated.errors.map(error => error.message),
            generatedCode: generated.valid ? undefined : generated.code
        };
    });
});
