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
            'Generate a valid single-file Thinai model. Declare subdomains exactly as `subdomain Commerce kind core` and `subdomain Fulfillment kind supporting`; include the `kind` keyword and do not terminate declarations with semicolons. Declare bounded contexts without braces, then put each context’s members in a separate `in bounded context Name { ... }` block: Ordering realizes Commerce, Shipping realizes Fulfillment, and Returns realizes Fulfillment. Add shared kernel CommonTypes with these members on separate lines:\nvalue object CorrelationId {\n  raw: string\n}\nenum Priority {\n  Normal,\n  Urgent\n}\nmodule SharedContracts {\n}\nIn Ordering, add module CoreTypes with an `exposes OrderReference` entry followed by `value object OrderReference { raw: string }` on separate lines. Add sibling module ApiTypes depends on CoreTypes containing `data object OrderRequest` with fields `reference: OrderReference` and `priority: Priority` on separate lines. Add context map CommerceMap containing all four relationship forms: a customer/supplier relationship from Ordering to Shipping where the customer lists `AntiCorruptionLayer` and the supplier lists `PublishedLanguage`, a partnership between Ordering and Returns, separate ways between Shipping and Returns, and a sharedKernel relationship whose participants list contains Ordering and Shipping. Put the first statement inside every non-empty block on a new line, and keep every reference valid.',
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

    evaluation('models aggregate identity, state, mirroring, and creation', async (context: EvalContext) => {
        const generated = await generateAndValidate(
            'Generate valid single-file Thinai source. Do not use semicolons, and put every sibling declaration and body statement on its own line. Declare subdomain Commerce kind core, bounded context Catalog realizes Commerce, and a separate `in bounded context Catalog` block containing aggregate Product. Product has root entity Product with identifier id: ProductId and sibling value object ProductId { raw: string }. Declare bounded context Ordering realizes Commerce with its own contribution block. In aggregate Order, declare root entity Order with method place() that emits OrderPlaced and transitions status from Draft to Placed, then give it identifier id: OrderId and status: OrderStatus initial Draft on separate lines. Add entity OrderLine with method ship() that transitions status from Open to Shipped, identifier id: OrderLineId, and status: LineStatus initial Open. Add entity SpecialOrderLine with its own identifier specialId: SpecialOrderLineId. Declare OrderLineId and OrderId value objects in Order, plus SpecialOrderLineId. Do not use a `child` keyword or entity inheritance. Add enums OrderStatus { Draft, Placed } and LineStatus { Open, Shipped }. Declare the mirror exactly as `value object CatalogProductId mirrors Catalog.Product.ProductId` with `raw: string` on the following line, then use CatalogProductId as OrderLine.productId. Outside the aggregate, declare repository OrderRepository block containing `manages Order.Order` and factory OrderFactory with method createOrder() returns Order.Order. Add application service OrderCommands with method createOrder() invoking OrderFactory.createOrder. Include aggregate invariant text and keep references valid.',
            context
        );
        const features = featureScore(generated.code, [
            'aggregate Order', 'root entity Order', 'entity SpecialOrderLine',
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
            'Generate a valid single-file Thinai Ordering bounded context. Do not use semicolon terminators; put each sibling declaration and body statement on its own line. Declare aggregate Order with root entity Order. Give it method place() with transition status from Draft to Placed. Give it method pay() with one grouped transition changing status from Placed to Paid and paymentStatus from Pending to Confirmed, followed by one shared descriptive when guard saying payment has been accepted. In the same method, emit OrderPaid and PaymentRecorded in one emits clause with a descriptive when guard. Add identifier id: OrderId, status: OrderStatus initial Draft, and paymentStatus: PaymentStatus initial Pending as separate fields. Declare sibling value object OrderId with raw: string, enums OrderStatus { Draft, Placed, Paid } and PaymentStatus { Pending, Confirmed }, and both events. Keep all references valid, and do not describe the guards as executable conditions.',
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
            'Generate a valid single-file Thinai Ordering bounded context. Put every sibling declaration and body statement on its own line and use no semicolons. Declare aggregate Order with root entity Order, identifier id: OrderId, status: OrderStatus initial Draft, and methods place() and ensureOwner(). Add enum OrderStatus { Draft, Placed } and sibling value object OrderId with raw: string. Add application service OrderApplication with method placeOrder() whose body invokes Order.Order.place with a descriptive when guard saying the order is ready to be placed. Make the guard explicit after the fully qualified invocation target, and do not describe it as executable or as bypassing invocation rules.',
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
            'Generate a valid single-file Thinai Ordering bounded context. Do not use semicolon terminators; place each sibling declaration and body statement on its own line. Declare aggregate Order with root entity Order and constructor(id: OrderId, details: OrderDetails). Give Order the identifier field id: OrderId. Declare sibling value object OrderId with raw: string and value object OrderDetails with address: string. Declare data object PlaceOrderInput with orderId: OrderId and deliveryAddress: string, then define application service OrderApplication with method placeOrder(input: PlaceOrderInput). Constructors must take domain values, never a DataObject or an event; keep the request DataObject as the application-service input. Ensure all references resolve.',
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
            'Generate a valid single-file Thinai Ordering bounded context. Do not use semicolon terminators. Declare aggregate Order containing root entity Order with method place() whose body emits OrderPlaced, and an identifier field id: OrderId. Put the method body, identifier field, and sibling value object OrderId on separate lines. Declare event OrderPlaced with fields orderId: string and status: string on separate lines. Declare module Contracts with an exposes entry for OrderPlacedV1 followed by integration event OrderPlacedV1 with its fields on separate lines. Declare read model OrderSummary with its fields on separate lines, query repository OrderSummaryRepository whose body serves OrderSummary, and projector OrderSummaryProjector with method onOrderPlaced(source: OrderPlaced) whose body declares projects OrderSummary and a behavior clause that links OrderPlaced.orderId and OrderSummary.orderId and may mention [[OrderSummaryRepository]]. Add application service OrderApplication with method placeOrder(id: OrderId) whose body invokes Order.Order.place, and method publish(source: OrderPlaced) whose body emits Contracts.OrderPlacedV1 and has the behavior clause "Map the internal event to the contract.". Both `place` and `publish` must contain their specified `emits` clause; do not omit either emission. Add query service OrderQueries with method search() returns List<OrderSummary> whose behavior specification links [[OrderSummaryRepository]]. Put the first statement in every non-empty block on a new line. Ensure all references resolve.',
            context
        );
        const features = featureScore(generated.code, [
            'event OrderPlaced {', 'integration event OrderPlacedV1 {', 'exposes OrderPlacedV1',
            'source: OrderPlaced', 'returns List<OrderSummary>', '[[OrderSummaryRepository]]'
        ]);
        const normalized = generated.code.toLowerCase().replace(/\s+/g, ' ');
        const hasDomainEventEmission = /\bemits\s+orderplaced(?:\s|,|\})/.test(normalized);
        const hasIntegrationEventEmission = /\bemits\s+contracts\.orderplacedv1(?:\s|,|\})/.test(normalized);
        const missingEmissions = [
            ...(!hasDomainEventEmission ? ['emits OrderPlaced'] : []),
            ...(!hasIntegrationEventEmission ? ['emits Contracts.OrderPlacedV1'] : [])
        ];
        const completeFeatureScore = (features.score * 6 + Number(hasDomainEventEmission) + Number(hasIntegrationEventEmission)) / 8;
        const hasReadsClause = /\breads\s+[A-Z_]/.test(generated.code);
        const score = generated.valid && !hasReadsClause ? completeFeatureScore : 0;
        return {
            ...generated.result.data,
            score,
            valid: generated.valid,
            featureScore: completeFeatureScore,
            missingFeatures: [...features.missing, ...missingEmissions],
            hasReadsClause,
            diagnostics: generated.errors.map(error => error.message),
            generatedCode: generated.valid ? undefined : generated.code
        };
    });

    evaluation('models optional fields, collection types, and domain services', async (context: EvalContext) => {
        const generated = await generateAndValidate(
            'Generate a valid single-file Thinai Inventory bounded context. Do not use semicolons and put each sibling declaration and method-body statement on its own line. Declare aggregate Stock with root entity Stock and separate fields identifier id: StockId, quantities: Map<string, integer>, and labels: Set<string>. Add sibling value object StockId with raw: string and enum StockState { Available, Reserved }. Declare data object StockSearch with separate fields sku?: string, warehouseIds: List<string>, and filters: Map<string, List<string>>. Add domain service AvailabilityPolicy with method canReserve(stockId: StockId, quantity: integer) returns boolean whose behavior explains the reservation rule; domain-service methods must not take DataObjects. Keep every declaration at its grammar-defined scope, use `?` only for optional fields, and ensure all references resolve.',
            context
        );
        const features = featureScore(generated.code, [
            'domain service AvailabilityPolicy', 'returns boolean',
            'sku?: string', 'Set<string>', 'Map<string, integer>',
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
