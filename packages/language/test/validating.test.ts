import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, type LangiumDocument, URI } from 'langium';
import { clearDocuments, parseHelper } from 'langium/test';
import type { Model } from 'thinai-language';
import { createThinaiServices, isModel } from 'thinai-language';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver-types';

let services: ReturnType<typeof createThinaiServices>;
let parse: ReturnType<typeof parseHelper<Model>>;
let documents: LangiumDocument[] = [];

beforeAll(() => {
    services = createThinaiServices(EmptyFileSystem);
    const doParse = parseHelper<Model>(services.Thinai);
    parse = (input: string) => doParse(input, { validation: true });
});

afterEach(async () => {
    await clearDocuments(services.shared, services.shared.workspace.LangiumDocuments.all.toArray());
    documents = [];
});

describe('Validating', () => {
    test('keeps an incomplete context-map relationship local while it is being typed', async () => {
        const prefixes = [
            'customer ',
            'customer Ordering',
            'customer Ordering ->',
            'customer Ordering -> supplier',
            'customer Ordering -> supplier Shipping'
        ];
        for (const [index, relationship] of prefixes.entries()) {
            const source = `bounded context Ordering
bounded context Shipping
context map Fulfillment {
    ${relationship}`;
            const document = await parse(source);
            const exceptionDiagnostics = document.diagnostics?.filter(diagnostic =>
                String(diagnostic.message).startsWith('An error occurred during validation:')
            ) ?? [];
            expect(exceptionDiagnostics, `prefix ${index}: ${relationship}`).toEqual([]);
            const mapStart = source.indexOf('context map Fulfillment');
            const mapEnd = source.length;
            const mapWideDiagnostics = document.diagnostics?.filter(diagnostic =>
                document.textDocument.offsetAt(diagnostic.range.start) <= mapStart &&
                document.textDocument.offsetAt(diagnostic.range.end) >= mapEnd
            ) ?? [];
            expect(mapWideDiagnostics, `prefix ${index}: ${relationship}`).toEqual([]);
        }
    });

    test('rejects a complete empty import path', async () => {
        const document = await parse(`import ""\nbounded context Alpha\n`);
        expect(semanticDiagnostics(document).some(diagnostic =>
            diagnostic.message === 'An import path must not be empty.'
        )).toBe(true);
    });

    test('does not throw while import paths or import clauses are incomplete', async () => {
        for (const [index, source] of ['import ', 'import { Foo } from '].entries()) {
            const document = await parse(source);
            const exceptionDiagnostics = document.diagnostics?.filter(diagnostic =>
                String(diagnostic.message).startsWith('An error occurred')
            ) ?? [];
            expect(exceptionDiagnostics, `incomplete import ${index}`).toEqual([]);
        }
    });

    test('does not crash shared-kernel checks while a context-map relationship is incomplete', async () => {
        const document = await parse(`bounded context Ordering in bounded context Ordering {
    application service App {
        method run() {
            invokes Common.Pricing.calculate
        }
    }
}
shared kernel Common {
    domain service Pricing {
        method calculate() {}
    }
}
context map Relations {
    sharedKernel`);
        const exceptionDiagnostics = document.diagnostics?.filter(diagnostic =>
            String(diagnostic.message).startsWith('An error occurred')
        ) ?? [];
        expect(exceptionDiagnostics).toEqual([]);
    });

    test('defers required-member diagnostics until the containing construct is complete', async () => {
        const incomplete = await parse(`bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        root entity Order {`);
        const incompleteMessages = incomplete.diagnostics?.map(diagnostic => String(diagnostic.message)) ?? [];
        expect(incompleteMessages.some(message => message.includes('exactly one root entity'))).toBe(false);
        expect(incompleteMessages.some(message => message.includes('exactly one identifier field'))).toBe(false);

        const complete = await parse(`bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        root entity Order {}
    }
}`);
        const completeMessages = complete.diagnostics?.map(diagnostic => String(diagnostic.message)) ?? [];
        expect(completeMessages.some(message => message.includes('exactly one identifier field'))).toBe(true);

        const incompleteProjector = await parse(`bounded context Ordering
in bounded context Ordering {
    projector OrderProjector {
        method project(event: OrderPlaced) {`);
        expect(incompleteProjector.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes('must declare at least one read model')
        )).toBe(false);

        const incompleteProjectorEmission = await parse(`bounded context Ordering
in bounded context Ordering {
    projector OrderProjector {
        method project(event: OrderPlaced) {
            emits`);
        expect(incompleteProjectorEmission.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes('cannot invoke domain/application methods, emit events')
        )).toBe(false);
    });

    test('anchors required-member diagnostics to declaration names', async () => {
        const cases = [
            {
                name: 'empty aggregate',
                source: `bounded context X
in bounded context X {
    aggregate Order {
    }
}`,
                message: 'exactly one root entity',
                expected: 'Order'
            },
            {
                name: 'aggregate with enum',
                source: `bounded context X
in bounded context X {
    aggregate Order {
        enum Status { A, B }
    }
}`,
                message: 'exactly one root entity',
                expected: 'Order'
            },
            {
                name: 'aggregate with value object',
                source: `bounded context X
in bounded context X {
    aggregate Order {
        value object Money { raw: string }
    }
}`,
                message: 'exactly one root entity',
                expected: 'Order'
            },
            {
                name: 'entity without identifier',
                source: `bounded context X
in bounded context X {
    aggregate Order {
        root entity Order {
            raw: string
        }
    }
}`,
                message: 'exactly one identifier field',
                expected: 'Order'
            },
            {
                name: 'journey without actors',
                source: `journey PlaceOrder {
}`,
                message: 'at least one actor block',
                expected: 'PlaceOrder'
            },
            {
                name: 'actor block without steps',
                source: `actor Customer
journey PlaceOrder {
    by Customer {
    }
}`,
                message: 'at least one command step',
                expected: 'Customer'
            },
            {
                name: 'projector method without projects',
                source: `bounded context X
in bounded context X {
    projector P {
        method run() {}
    }
}`,
                message: 'at least one read model',
                expected: 'run'
            }
        ];

        for (const { name, source, message, expected } of cases) {
            const document = await parse(source);
            const diagnostic = document.diagnostics?.find(candidate =>
                String(candidate.message).includes(message)
            );
            expect(diagnostic, name).toBeDefined();
            expect(document.textDocument.getText(diagnostic!.range), name).toBe(expected);
        }
    });

    test('defers participant and journey-step requirements while their blocks are open', async () => {
        const incomplete = await parse(`bounded context Ordering
shared kernel Common {}
context map Fulfillment {
    sharedKernel Common {
        participants: [Ordering`);
        const incompleteMessages = incomplete.diagnostics?.map(diagnostic => String(diagnostic.message)) ?? [];
        expect(incompleteMessages.some(message => message.includes('must include at least two bounded contexts'))).toBe(false);

        const complete = await parse(`bounded context Ordering
shared kernel Common {}
context map Fulfillment {
    sharedKernel Common {
        participants: [Ordering]
    }
}`);
        expect(complete.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes('must include at least two bounded contexts')
        )).toBe(true);

        const incompleteJourney = await parse(`actor Customer
journey PlaceOrder {
    by Customer {`);
        expect(incompleteJourney.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes('must contain at least one command step')
        )).toBe(false);

        const completeJourney = await parse(`actor Customer
journey PlaceOrder {
    by Customer {}
}`);
        expect(completeJourney.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes('must contain at least one command step')
        )).toBe(true);
    });

    test('defers transition and collection semantics while their syntax is incomplete', async () => {
        const incompleteTransition = await parse(`bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        root entity Order {
            method ship() {
                transition status from Draft to
            }
            identifier id: OrderId
            status: OrderStatus
        }
        value object OrderId { raw: string }
        enum OrderStatus { Draft, Shipped }
    }
}`);
        expect(incompleteTransition.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes('A transition must target an enum field')
        )).toBe(false);

        const incompleteCollection = await parse(`bounded context Ordering
in bounded context Ordering {
    value object OrderId {
        keys: Map<string,
    }
}`);
        expect(incompleteCollection.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes('A Map type requires both a key and a value type')
        )).toBe(false);

        const completeInvalidCollection = await parse(`bounded context Ordering
in bounded context Ordering {
    value object OrderId {
        keys: Map<string>
    }
}`);
        expect(completeInvalidCollection.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes('A Map type requires both a key and a value type')
        )).toBe(true);
    });

    test('does not report missing repository and method return types before their declarations are complete', async () => {
        const incompleteRepository = await parse(`bounded context Ordering
in bounded context Ordering {
    repository OrderRepository {
        manages`);
        const repositoryMessages = incompleteRepository.diagnostics?.map(diagnostic => String(diagnostic.message)) ?? [];
        expect(repositoryMessages.some(message => message.startsWith('An error occurred'))).toBe(false);
        expect(repositoryMessages.some(message => message.includes('must manage an aggregate-root entity'))).toBe(false);

        const incompleteQuery = await parse(`bounded context Ordering
in bounded context Ordering {
    query service Orders {
        method search(`);
        expect(incompleteQuery.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes('A query must declare a result type')
        )).toBe(false);

        const incompleteFactory = await parse(`bounded context Ordering
in bounded context Ordering {
    factory OrderFactory {
        method create(`);
        expect(incompleteFactory.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes('A factory method must return an aggregate-root entity')
        )).toBe(false);
    });

    test('requires line breaks between sibling declarations and body statements', async () => {
        const compact = await parse(`bounded context Ordering in bounded context Ordering { aggregate Order { root entity Order { method place() { invariant "An order exists" behavior "Place it" } identifier id: OrderId status: Status } value object OrderId { raw: string } enum Status { Draft, Placed } }}`);
        const compactLayoutErrors = compact.diagnostics?.filter(diagnostic => diagnostic.code === 'line-break-required') ?? [];
        expect(compactLayoutErrors.length).toBeGreaterThanOrEqual(3);
        expect(compactLayoutErrors.every(diagnostic => diagnostic.severity === DiagnosticSeverity.Error)).toBe(true);

        const multiline = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place() {
                            invariant "An order exists"
                            behavior "Place it"
                        }
                        identifier id: OrderId
                        status: Status
                    }
                    value object OrderId {
                        raw: string
                    }
                    enum Status { Draft, Placed }
                }
            }
        `);
        expect(multiline.diagnostics?.filter(diagnostic => diagnostic.code === 'line-break-required')).toEqual([]);
        expect(multiline.diagnostics?.filter(diagnostic => diagnostic.code === 'line-break-required-after-open-brace'))
            .toEqual([]);
    });

    test('requires the first statement in a non-empty block to follow the opening brace on a new line', async () => {
        const inline = await parse(`bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        value object OrderId { raw: string }
        root entity Order {
            identifier id: OrderId
        }
    }
}`);
        expect(inline.diagnostics?.filter(diagnostic => diagnostic.code === 'line-break-required-after-open-brace'))
            .toHaveLength(1);

        const inlineMethodBody = await parse(`bounded context Ordering
in bounded context Ordering {
    application service Orders {
        method place() { behavior "Place the order" }
    }
}`);
        expect(inlineMethodBody.diagnostics?.filter(diagnostic =>
            diagnostic.code === 'line-break-required-after-open-brace'
        )).toHaveLength(1);

        const braceInComment = await parse(`bounded context Ordering
in bounded context Ordering {
    domain service Orders /* fake {
    */ { method place() {} }
}`);
        expect(braceInComment.diagnostics?.filter(diagnostic =>
            diagnostic.code === 'line-break-required-after-open-brace'
        )).toHaveLength(1);

        const emptyBlock = await parse(`bounded context Ordering
in bounded context Ordering {
    module Empty {}
}`);
        expect(emptyBlock.diagnostics?.filter(diagnostic => diagnostic.code === 'line-break-required-after-open-brace'))
            .toEqual([]);
    });

    test('requires first body clauses on a new line in reference-only blocks', async () => {
        const document = await parse(`bounded context Ordering
bounded context Shipping
shared kernel Common {}
in bounded context Ordering {
    aggregate Order {
        root entity Order {
            identifier id: OrderId
        }
        value object OrderId {
            raw: string
        }
    }
    read model Summary {}
    repository Orders { manages Order.Order }
    query repository SummaryQueries { serves Summary }
}
context map Relations {
    sharedKernel Common { participants: [Ordering, Shipping] }
    customer Ordering { integrationPatterns: ["AntiCorruptionLayer"] } -> supplier Shipping
}`);

        const diagnostics = document.diagnostics?.filter(diagnostic =>
            diagnostic.code === 'line-break-required-after-open-brace'
        ) ?? [];
        const source = document.textDocument.getText();
        const expectedOffsets = ['manages', 'serves', 'participants', 'integrationPatterns']
            .map(keyword => source.indexOf(keyword))
            .sort((left, right) => left - right);

        expect(diagnostics.map(diagnostic => document.textDocument.offsetAt(diagnostic.range.start))
            .sort((left, right) => left - right)).toEqual(expectedOffsets);
    });

    test('allows entity and value-object members in source order', async () => {
        const document = await parse(`bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        root entity Order {
            identifier id: OrderId
            method place() {}
            constructor(id: OrderId) {}
        }
        value object OrderId {
            raw: string
            method normalized() {}
            constructor(raw: string) {}
        }
    }
}`);
        expect(document.parseResult.parserErrors).toEqual([]);
        expect(document.diagnostics?.filter(diagnostic => diagnostic.code === 'line-break-required-after-open-brace'))
            .toEqual([]);
        expect(document.diagnostics?.filter(diagnostic => diagnostic.code === 'line-break-required')).toEqual([]);
    });

    test('accepts aggregate effects and an application-service command', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place() {
                            emits OrderPlaced, OrderAudited
                            transition status from Draft to Placed
                        }
                        identifier id: OrderId
                        status: OrderStatus
                    }
                    value object OrderId {
                        raw: string
                    }
                    enum OrderStatus { Draft, Placed }
                }
                repository OrderRepository {
                    manages Order.Order
                }
                application service OrderApplication {
                    method placeOrder(id: OrderId) {
                        invokes Order.Order.place
                    }
                }
                event OrderPlaced
                event OrderAudited
            }
        `);
        expect(checkDocumentValid(document) || semanticDiagnostics(document).map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('requires identifier fields to reference value objects', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: string }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An identifier field must reference a value object.'
        ))).toBe(true);
    });

    test('requires references to another aggregate entity to use its identifier', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Customer {
                    root entity Customer {
                        identifier id: CustomerId
                    }
                    value object CustomerId { raw: string }
                }
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId
                        buyer: Customer
                    }
                    value object OrderId { raw: string }
                }
            }
        `);
        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An aggregate must reference another aggregate through its identifier'
        ))).toBe(true);
    });

    test('allows a non-root entity to identify itself and transition its own state', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                    entity OrderLine {
                        method ship() { transition status from Open to Shipped }
                        identifier id: OrderLineId
                        status: LineStatus
                    }
                    value object OrderLineId { raw: string }
                    enum LineStatus { Open, Shipped }
                }
            }
        `);

        expect(checkDocumentValid(document) || semanticDiagnostics(document).map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('allows the aggregate root to coordinate a child-entity transition', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method shipLine(lineId: OrderLineId) {
                            invokes Order.OrderLine.ship
                        }
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                    entity OrderLine {
                        method ship() { transition status from Open to Shipped }
                        identifier id: OrderLineId
                        status: LineStatus initial Open
                    }
                    value object OrderLineId { raw: string }
                    enum LineStatus { Open, Shipped }
                }
                repository OrderRepository {
                    manages Order.Order
                }
                application service OrderApplication {
                    method shipLine(id: OrderId) {
                        invokes Order.Order.shipLine
                    }
                }
            }
        `);

        expect(checkDocumentValid(document) || semanticDiagnostics(document).map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('validates a state graph from its declared initial state', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place() { transition status from Draft to Placed }
                        method pay() { transition status from Placed to Paid }
                        identifier id: OrderId
                        status: OrderStatus initial Draft
                    }
                    value object OrderId { raw: string }
                    enum OrderStatus { Draft, Placed, Paid }
                }
            }
        `);

        expect(checkDocumentValid(document) || semanticDiagnostics(document).map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('rejects an initial state from a different enum', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId
                        status: OrderStatus initial Pending
                    }
                    value object OrderId { raw: string }
                    enum OrderStatus { Draft, Placed }
                    enum PaymentStatus { Pending, Paid }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes('initial state') || String(diagnostic.message).includes('Pending')
        )).toBe(true);
    });

    test('underlines initial when it is used outside a required entity enum field', async () => {
        const source = `bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order {
                    identifier id: OrderId
                    optionalStatus?: OrderStatus initial Draft
                    note: string initial Draft
                    status: OrderStatus initial Draft
                }
                value object OrderId { raw: string }
                value object StatusHolder { status: OrderStatus initial Draft }
                enum OrderStatus { Draft }
            }
        }`;
        const document = await parse(source);
        const diagnostics = semanticDiagnostics(document).filter(diagnostic =>
            String(diagnostic.message) === 'An initial state must be a declared value of a non-optional enum field on an entity.'
        );
        const expectedOffsets = [
            source.indexOf('initial Draft'),
            source.indexOf('initial Draft', source.indexOf('initial Draft') + 1),
            source.lastIndexOf('initial Draft')
        ].sort((left, right) => left - right);

        expect(diagnostics).toHaveLength(3);
        expect(diagnostics.map(diagnostic => document.textDocument.offsetAt(diagnostic.range.start)).sort((left, right) => left - right))
            .toEqual(expectedOffsets);
    });

    test('allows the same transition in different methods', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place() { transition status from Draft to Placed }
                        method placeFromImport() { transition status from Draft to Placed }
                        identifier id: OrderId
                        status: OrderStatus initial Draft
                    }
                    value object OrderId { raw: string }
                    enum OrderStatus { Draft, Placed }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes('Duplicate state transition'))).toBe(false);
    });

    test('allows repeated transition fields across statements but rejects them within one statement', async () => {
        const separateStatements = await parse(`bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order {
                    method advance() {
                        transition status from Draft to Placed
                        transition status from Placed to Shipped
                    }
                    identifier id: OrderId
                    status: OrderStatus initial Draft
                }
                value object OrderId { raw: string }
                enum OrderStatus { Draft, Placed, Shipped }
            }
        }`);
        expect(semanticDiagnostics(separateStatements).filter(diagnostic => diagnostic.severity === 1).map(diagnostic => diagnostic.message)).toEqual([]);

        const repeatedInStatement = await parse(`bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order {
                    method advance() {
                        transition status from Draft to Placed, status from Placed to Shipped
                    }
                    identifier id: OrderId
                    status: OrderStatus initial Draft
                }
                value object OrderId { raw: string }
                enum OrderStatus { Draft, Placed, Shipped }
            }
        }`);
        expect(repeatedInStatement.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes("A transition may change field 'status' only once per statement.")
        )).toBe(true);
    });

    test('rejects transitions that leave a field in the same state', async () => {
        const document = await parse(`bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order {
                    method place() { transition status from Draft to Draft }
                    identifier id: OrderId
                    status: OrderStatus initial Draft
                }
                value object OrderId { raw: string }
                enum OrderStatus { Draft, Placed }
            }
        }`);
        expect(document.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes('A transition must move to a different state.')
        )).toBe(true);
    });

    test('warns when a method repeats the same transition', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place() {
                            transition status from Draft to Placed
                            transition status from Draft to Placed
                        }
                        identifier id: OrderId
                        status: OrderStatus initial Draft
                    }
                    value object OrderId { raw: string }
                    enum OrderStatus { Draft, Placed }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic =>
            diagnostic.severity === DiagnosticSeverity.Warning && String(diagnostic.message).includes(
                "Duplicate state transition 'Draft -> Placed' for 'status' in the same method."
            )
        )).toBe(true);
    });

    test('validates guarded emissions and coordinated transitions across fields', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method confirmPayment() {
                            transition status from Draft to Placed,
                                       paymentStatus from Pending to Confirmed
                                when "Payment is accepted for [[status]] and [[paymentStatus]]."
                            emits OrderPlaced, PaymentConfirmed
                                when "The [[paymentStatus]] state change is accepted."
                            emits OrderAudited
                        }
                        identifier id: OrderId
                        status: OrderStatus initial Draft
                        paymentStatus: PaymentStatus initial Pending
                    }
                    value object OrderId { raw: string }
                    enum OrderStatus { Draft, Placed }
                    enum PaymentStatus { Pending, Confirmed }
                }
                event OrderPlaced
                event PaymentConfirmed
                event OrderAudited
            }
        `);

        expect(checkDocumentValid(document) || semanticDiagnostics(document).map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('rejects unreachable transition sources from the declared initial state', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place() { transition status from Draft to Placed }
                        method reopen() { transition status from Cancelled to Draft }
                        identifier id: OrderId
                        status: OrderStatus initial Draft
                    }
                    value object OrderId { raw: string }
                    enum OrderStatus { Draft, Placed, Cancelled }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            "State 'Cancelled' is unreachable from initial state 'Draft'."
        ))).toBe(true);
    });

    test('allows state enum values that are not part of a field state graph', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                enum OrderStatus { Draft, Placed, Cancelled }
                data object OrderDto { status: OrderStatus }
                aggregate Order {
                    root entity Order {
                        method place() { transition status from Draft to Placed }
                        identifier id: OrderId
                        status: OrderStatus initial Draft
                    }
                    value object OrderId { raw: string }
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic =>
            diagnostic.severity === DiagnosticSeverity.Error &&
            String(diagnostic.message).includes('is unreachable from initial state')
        )).toEqual([]);
    });

    test('rejects duplicate fields and enum values', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        constructor(id: OrderId)
                        constructor(otherId: OrderId)
                        identifier id: OrderId
                        status: string
                        status: string
                    }
                    value object OrderId { raw: string }
                    enum OrderStatus { Draft, Draft }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes("Duplicate field 'status'."))).toBe(true);
        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes("Duplicate enum value 'Draft'."))).toBe(true);
        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes('Duplicate constructor signature.'))).toBe(true);
    });

    test('does not conflate unresolved constructor parameter types', async () => {
        const document = await parse(`bounded context Ordering in bounded context Ordering {
            value object Request {
                constructor(left: MissingLeft)
                constructor(right: MissingRight)
            }
        }`);

        expect(document.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes('Duplicate constructor signature.')
        )).toBe(false);
    });

    test('accepts domain-value constructor inputs and DataObject application-service inputs', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        constructor(id: OrderId, total: Money, owner: string)
                        identifier id: OrderId
                    }
                    value object OrderId {
                        constructor(raw: string)
                        raw: string
                    }
                    value object Money {
                        constructor(amount: decimal, currency: string)
                        amount: decimal
                        currency: string
                    }
                }
                data object PlaceOrderInput { orderId: OrderId }
                application service OrderApplication {
                    method placeOrder(input: PlaceOrderInput)
                }
            }
        `);

        expect(checkDocumentValid(document) || semanticDiagnostics(document).map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('rejects DataObject inputs to entity and value-object constructors', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        constructor(input: PlaceOrderInput)
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                    value object Money {
                        constructor(input: PlaceOrderInput)
                        amount: decimal
                    }
                }
                data object PlaceOrderInput { amount: decimal }
            }
        `);

        expect(document.diagnostics?.filter(diagnostic => String(diagnostic.message).includes(
            'Constructors must accept domain values, not DataObjects'
        ))).toHaveLength(2);
    });

    test('rejects event-typed constructor parameters', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        constructor(source: OrderCreated)
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                }
                event OrderCreated
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Constructors must not accept events'
        ))).toBe(true);
    });

    test('requires constructors to use an identifier instead of another aggregate root', async () => {
        const document = await parse(`
            bounded context Commerce in bounded context Commerce {
                aggregate CustomerRecords {
                    root entity Buyer { identifier id: BuyerId }
                    value object BuyerId { raw: string }
                }
                aggregate Order {
                    root entity Order {
                        constructor(buyer: Buyer)
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'A constructor must reference another aggregate through its identifier'
        ))).toBe(true);
    });

    test('requires each entity to declare an identifier', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                    entity OrderLine { quantity: integer }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An entity must declare exactly one identifier field.'
        ))).toBe(true);
    });

    test('rejects optional entity identifiers', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id?: OrderId }
                    value object OrderId { raw: string }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An entity identifier field cannot be optional.'
        ))).toBe(true);
    });

    test('requires entities to belong to an aggregate', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                entity Order {
                    identifier id: OrderId
                }
                value object OrderId { raw: string }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An entity must belong to an aggregate.'
        ))).toBe(true);
    });

    test('requires an entity identifier value object to belong to that aggregate', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Customer {
                    root entity Customer { identifier id: CustomerId }
                    value object CustomerId { raw: string }
                }
                aggregate Order {
                    root entity Order { identifier id: CustomerId }
                    value object OrderId { raw: string }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An entity identifier value object must be declared in the same aggregate.'
        ))).toBe(true);
    });

    test('requires an entity transition to target a field on that entity', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method placeLine() { transition status from Open to Shipped }
                        identifier id: OrderId
                        lineStatus: OrderStatus
                    }
                    value object OrderId { raw: string }
                    entity OrderLine {
                        method ship() { transition status from Open to Shipped }
                        identifier id: OrderLineId
                        status: OrderStatus
                    }
                    value object OrderLineId { raw: string }
                    enum OrderStatus { Open, Shipped }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'A transition must target an enum field declared on the owning entity.'
        ))).toBe(true);
    });

    test('requires application services to enter an aggregate through its root', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                    entity OrderLine {
                        method ship()
                        identifier id: OrderLineId
                    }
                    value object OrderLineId { raw: string }
                }
                repository OrderRepository {
                    manages Order.Order
                }
                application service OrderApplication {
                    method shipLine(id: OrderId) {
                        invokes Order.OrderLine.ship
                    }
                }
            }
        `);

        const messages = (document.diagnostics ?? []).map(diagnostic => String(diagnostic.message));
        expect(messages.filter(message =>
            message === 'An application service may invoke only aggregate-root behavior or a factory method that creates an aggregate root.'
        )).toHaveLength(1);
        expect(messages).not.toContain('Only entity behavior may invoke child-entity methods; aggregate-root behavior must coordinate aggregate changes.');
    });

    test('reports one primary diagnostic for invalid event handler roles', async () => {
        const document = await parse(`
            bounded context C
            in bounded context C {
                event E
                read model R {
                    text: string
                }
                projector P {
                    method handle(a: E, b: string) {
                        projects R
                    }
                }
                query service Q {
                    method find(e: E) returns string
                }
            }
        `);
        const messages = (document.diagnostics ?? []).map(diagnostic => String(diagnostic.message));
        expect(messages.filter(message => message === 'A projector method must handle exactly one domain or integration event.'))
            .toHaveLength(1);
        expect(messages).not.toContain('An event-triggered method must have exactly one event-typed parameter.');
        expect(messages.filter(message => message === 'A query cannot handle events.'))
            .toHaveLength(1);
        expect(messages).not.toContain('Event-typed method parameters are allowed only on application-service handlers and projectors.');
    });

    test('allows an application service to coordinate multiple aggregate roots', async () => {
        const document = await parse(`
            bounded context Commerce in bounded context Commerce {
                aggregate Order {
                    root entity Order { method place() identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                aggregate Customer {
                    root entity Customer { method register() identifier id: CustomerId }
                    value object CustomerId { raw: string }
                }
                application service Checkout {
                    method completePurchase() {
                        invokes Order.Order.place
                        invokes Customer.Customer.register
                    }
                }
            }
        `);

        expect(document.parseResult.parserErrors).toHaveLength(0);
        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1)).toHaveLength(0);
    });

    test('prevents child entities from crossing into application-service signatures', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                    entity OrderLine { identifier id: OrderLineId }
                    value object OrderLineId { raw: string }
                }
                application service OrderApplication {
                    method updateLine(line: OrderLine)
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Application-service signatures must use identifiers or data values, not entity instances.'
        ))).toBe(true);
    });

    test('prevents domain behavior from invoking application-service methods', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                domain service Pricing {
                    method calculate() { invokes OrderApplication.placeOrder }
                }
                application service OrderApplication {
                    method placeOrder()
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Domain behavior cannot invoke an application-service method.'
        ))).toBe(true);
    });

    test('prevents domain call chains from reaching application services', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order { root entity Order { identifier id: OrderId } value object OrderId { raw: string } }
                domain service Pricing {
                    method calculate() { invokes OrderApplication.placeOrder }
                }
                domain service Reporting {
                    method report() { invokes Pricing.calculate }
                }
                application service OrderApplication { method placeOrder() }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Domain behavior cannot transitively invoke an application-service method.'
        ))).toBe(true);
    });

    test('prevents domain services from invoking aggregate-owned methods', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order { method place() identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                domain service OrderPolicy {
                    method apply() { invokes Order.Order.place }
                }
                application service OrderApplication {
                    method placeOrder() { invokes OrderPolicy.apply }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'A domain service must not invoke aggregate-owned methods'
        ))).toBe(true);
    });

    test('prevents domain-service call chains from reaching aggregate-owned methods', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order { method place() identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                domain service OrderPolicy {
                    method apply() { invokes OrderCalculator.calculate }
                }
                domain service OrderCalculator {
                    method calculate() { invokes Order.Order.place }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'A domain service must not invoke aggregate-owned methods'
        ))).toBe(true);
    });

    test('prevents aggregate-owned methods from invoking domain services', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place() { invokes OrderPolicy.calculate }
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                }
                domain service OrderPolicy { method calculate() }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Aggregate-owned methods must not invoke domain services'
        ))).toBe(true);
    });

    test('prevents aggregate-owned call chains from reaching domain services', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place() { invokes OrderPricing.calculate }
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                    value object OrderPricing {
                        method calculate() { invokes PricingPolicy.calculate }
                    }
                }
                domain service PricingPolicy { method calculate() }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Aggregate-owned methods must not invoke domain services'
        ))).toBe(true);
    });

    test('allows application services to invoke a pure domain service and aggregate root directly', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                value object PriceRequest { subtotal: decimal }
                value object PriceQuote { total: decimal }
                aggregate Order {
                    root entity Order {
                        method place(quote: PriceQuote) returns PriceQuote
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                }
                domain service PricingPolicy {
                    method calculate(request: PriceRequest) returns PriceQuote
                    method inspect(order: Order.Order) returns PriceQuote
                }
                application service OrderApplication {
                    method placeOrder(request: PriceRequest) returns PriceQuote {
                        invokes PricingPolicy.calculate
                        invokes Order.Order.place
                    }
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1).map(diagnostic => diagnostic.message)).toEqual([]);
    });

    test('prevents domain services from returning aggregate entities', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                domain service OrderPolicy {
                    method findOrder() returns Order.Order
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Domain-service methods must return domain values, not aggregate entities.'
        ))).toBe(true);
    });

    test('allows aggregates to omit an optional write-repository declaration', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1).map(diagnostic => diagnostic.message)).toEqual([]);
    });

    test('prevents a context-level domain service from invoking a child entity directly', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                    entity OrderLine { method ship() identifier id: OrderLineId }
                    value object OrderLineId { raw: string }
                }
                domain service ShippingPolicy {
                    method shipLine() { invokes Order.OrderLine.ship }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'A domain service must not invoke aggregate-owned methods'
        ))).toBe(true);
    });

    test('allows command journeys to describe query results without invoking the query', async () => {
        const document = await parse(`
            actor Customer
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order { method place() identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                repository OrderRepository {
                    manages Order.Order
                }
                read model OrderLookup { eligible: boolean }
                query service OrderQueries {
                    method lookup() returns boolean {
                        reads from OrderLookupRepository
                        behavior "Read [[OrderLookupRepository]] to determine whether the order can be placed."
                    }
                }
                query repository OrderLookupRepository {
                    serves OrderLookup
                }
                application service OrderCommands {
                    method placeOrder(id: OrderId) {
                        invokes Order.Order.place
                    }
                }
            }
            journey LookupOrder {
                by Customer {
                    invoke Ordering.OrderCommands.placeOrder with "id from [[id.raw]]" when "The check [[Ordering.OrderQueries.lookup.result]] reports that the order can be placed."
                }
            }
        `);

        expect(checkDocumentValid(document) || semanticDiagnostics(document).map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('allows a command-led journey to invoke a visible query service as a read step', async () => {
        const document = await parse(`
            actor Customer
            bounded context Ordering in bounded context Ordering {
                read model OrderSummary {
                    orderId: string
                }
                query repository OrderSummaryRepository {
                    serves OrderSummary
                }
                query service OrderQueries {
                    method findOrder(orderId: string) returns OrderSummary {
                        reads from OrderSummaryRepository
                    }
                }
                application service OrderApplication {
                    method placeOrder(orderId: string) {
                        behavior "Place the selected order."
                    }
                }
            }
            journey PlaceOrder {
                by Customer {
                    invoke Ordering.OrderQueries.findOrder
                        with "the order selected by the customer"
                    invoke Ordering.OrderApplication.placeOrder
                        with "the order identified by [[Ordering.OrderQueries.findOrder.result.orderId]]"
                        when "The summary is available."
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('allows an exposed cross-context query service as a journey read step', async () => {
        const document = await parse(`
            bounded context Source
            in bounded context Source {
                module Api {
                    exposes Queries
                    query service Queries {
                        method find() returns string
                    }
                }
            }
            bounded context Consumer
            in bounded context Consumer {
                application service App {
                    method run() {
                        behavior "Run the consumer action."
                    }
                }
            }
            actor Customer
            journey ReadValue {
                by Customer {
                    invoke Source.Api.Queries.find
                    invoke Consumer.App.run
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('rejects a hidden module-nested query service as a journey step', async () => {
        const document = await parse(`
            actor Customer
            bounded context Ordering in bounded context Ordering {
                module Internal {
                    query service HiddenQueries {
                        method find() returns string
                    }
                }
                application service OrderApplication {
                    method placeOrder() {
                        behavior "Place the order."
                    }
                }
            }
            journey PlaceOrder {
                by Customer {
                    invoke Ordering.Internal.HiddenQueries.find
                    invoke Ordering.OrderApplication.placeOrder
                }
            }
        `);

        expect(semanticDiagnostics(document).map(diagnostic => String(diagnostic.message))).toContain(
            'A journey query step must target a context-level or module-exposed query service.'
        );
    });

    test('rejects an event handler as a journey step', async () => {
        const document = await parse(`
            actor Customer
            bounded context Ordering in bounded context Ordering {
                event OrderPlaced
                application service OrderApplication {
                    method placeOrder() {
                        behavior "Place the order."
                    }
                    method onOrderPlaced(source: OrderPlaced) {
                        behavior "React to the placed order."
                    }
                }
            }
            journey PlaceOrder {
                by Customer {
                    invoke Ordering.OrderApplication.onOrderPlaced
                    invoke Ordering.OrderApplication.placeOrder
                }
            }
        `);

        expect(semanticDiagnostics(document).map(diagnostic => String(diagnostic.message))).toContain(
            'A journey may invoke only application-service commands and visible query-service methods, not event handlers or other operations.'
        );
    });

    test('keeps journeys command-led when an actor block contains only a query step', async () => {
        const document = await parse(`
            actor Customer
            bounded context Ordering in bounded context Ordering {
                query service OrderQueries {
                    method find() returns string
                }
                application service OrderApplication {
                    method placeOrder() {
                        behavior "Place the order."
                    }
                }
            }
            journey ReadOrder {
                by Customer {
                    invoke Ordering.OrderQueries.find
                }
            }
        `);

        expect(semanticDiagnostics(document).map(diagnostic => String(diagnostic.message))).toContain(
            'An actor block in a journey must contain at least one command step.'
        );
    });

    test('allows direct and projector-backed query repositories side by side', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                event OrderPlaced
                read model OrderSummary {
                    orderId: OrderId
                    status: string
                }
                read model OrderLookup {
                    orderId: OrderId
                    status: string
                }
                query repository OrderSummaryRepository {
                    serves OrderSummary
                }
                query repository OrderLookupRepository {
                    serves OrderLookup
                    reads from Order
                }
                projector OrderSummaryProjector {
                    method onOrderPlaced(source: OrderPlaced) {
                        projects OrderSummary
                    }
                }
                query service OrderQueries {
                    method findSummary(id: OrderId) returns OrderSummary {
                        reads from OrderSummaryRepository
                    }
                    method findLookup(id: OrderId) returns OrderLookup {
                        reads from OrderLookupRepository
                    }
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('rejects handling a local integration event in the same bounded context', async () => {
        const projector = await parse(`
            bounded context Ordering in bounded context Ordering {
                integration event LocalIntegration {
                    orderId: string
                }
                read model LocalView {
                    orderId: string
                }
                projector LocalProjector {
                    method onLocal(source: LocalIntegration) {
                        projects LocalView
                    }
                }
            }
        `);
        expect(semanticDiagnostics(projector).map(diagnostic => diagnostic.message)).toContain(
            'An integration event can be handled only outside its owning bounded context; use the domain event for same-context reactions.'
        );

        const handler = await parse(`
            bounded context Ordering in bounded context Ordering {
                integration event LocalIntegration {
                    orderId: string
                }
                application service LocalHandler {
                    method onLocal(source: LocalIntegration)
                }
            }
        `);
        expect(semanticDiagnostics(handler).map(diagnostic => diagnostic.message)).toContain(
            'An integration event can be handled only outside its owning bounded context; use the domain event for same-context reactions.'
        );
    });

    test('allows an authorized projector to handle another context integration event', async () => {
        const document = await parse(`
            bounded context Ordering
            bounded context Shipping
            in bounded context Ordering {
                module Contracts {
                    exposes OrderPlacedV1
                    integration event OrderPlacedV1 {
                        orderId: string
                    }
                }
            }
            in bounded context Shipping {
                read model ShipmentView {
                    orderId: string
                }
                projector ShipmentProjector {
                    method onOrderPlaced(source: Ordering.Contracts.OrderPlacedV1) {
                        projects ShipmentView
                    }
                }
            }
            context map Fulfillment {
                customer Shipping -> supplier Ordering
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('does not require repository choreography in application-service methods', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                repository OrderRepository {
                    manages Order.Order
                }
                application service OrderApplication {
                    method placeOrder(id: OrderId) {
                        behavior "Place an order using the supplied identifier."
                    }
                }
            }
        `);

        expect(checkDocumentValid(document) || semanticDiagnostics(document).map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('allows application services to orchestrate commands and cross-aggregate query reads', async () => {
        const document = await parse(`
            actor Customer
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place()
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                }
                repository OrderWriteRepository {
                    manages Order.Order
                }
                aggregate Customer {
                    root entity Customer {
                        method activate()
                        identifier id: CustomerId
                    }
                    value object CustomerId { raw: string }
                }
                repository CustomerWriteRepository {
                    manages Customer.Customer
                }
                read model OrderSearch { orderNumber: string }
                read model CustomerHistory { customerName: string }
                query repository OrderSearchRepository {
                    serves OrderSearch
                    reads from Order
                }
                query repository CustomerHistoryRepository {
                    serves CustomerHistory
                    reads from Customer
                }
                application service OrderCommands {
                    method placeOrder(id: OrderId) {
                        invokes Order.Order.place
                    }
                }
                application service CustomerCommands {
                    method activateCustomer(id: CustomerId) {
                        invokes Customer.Customer.activate
                    }
                }
                query service OrderingReports {
                    method findOrders(text: string) returns string {
                        reads from OrderSearchRepository, CustomerHistoryRepository
                        behavior "Combine [[OrderSearchRepository]] with [[CustomerHistoryRepository]] for the report."
                    }
                }
            }
            journey ActivateCustomerAndPlaceOrder {
                by Customer {
                    invoke Ordering.CustomerCommands.activateCustomer with "id from [[id.raw]]"
                    invoke Ordering.OrderCommands.placeOrder with "id from [[id.raw]]"
                }
            }
        `);

        expect(checkDocumentValid(document) || semanticDiagnostics(document).map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('supports read models, projectors, command journeys, and descriptive guards', async () => {
        const document = await parse(`
            actor Customer
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place()
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                    enum OrderStatus { Draft, Placed }
                }
                repository OrderRepository {
                    manages Order.Order
                }
                data object PlaceOrderInput {
                    orderId: OrderId
                    requestedStatus: OrderStatus
                }
                data object PlaceOrderResult {
                    orderId: OrderId
                    status: OrderStatus
                }
                read model OrderEligibility {
                    orderId: OrderId
                    status: OrderStatus
                    eligible: boolean
                }
                query repository OrderEligibilityRepository {
                    serves OrderEligibility
                }
                event OrderPlaced { orderId: string }
                projector OrderEligibilityProjector {
                    method onOrderPlaced(source: OrderPlaced) {
                        projects OrderEligibility
                        behavior "Copy [[OrderPlaced.orderId]] into [[OrderEligibility.orderId]] via [[OrderEligibilityRepository]], then update [[OrderEligibility.status]]."
                    }
                }
                query service OrderQueries {
                    method canPlace(orderId: OrderId) returns OrderEligibility {
                        reads from OrderEligibilityRepository
                        behavior "Read [[OrderEligibilityRepository]] and return [[result.eligible]] for [[orderId]]."
                    }
                }
                application service OrderCommands {
                    method place(input: PlaceOrderInput) returns PlaceOrderResult {
                        invokes Order.Order.place
                        behavior "Place the order for [[input.orderId]] and return its [[result.status]]."
                    }
                }
            }
            journey PlaceOrder {
                by Customer {
                    invoke Ordering.OrderCommands.place with "input.orderId from [[input.orderId]] and input.requestedStatus from the customer selection"
                        when "The eligibility query [[Ordering.OrderQueries.canPlace.result.eligible]] reports that placement is allowed."
                }
            }
        `);

        expect(checkDocumentValid(document) || semanticDiagnostics(document).map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('allows nested data objects but rejects entity and read-model fields', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                    entity OrderLine { identifier id: OrderLineId }
                    value object OrderLineId { raw: string }
                }
                read model OrderSummary { status: string }
                data object Address { street: string }
                data object ShippingInput {
                    address: Address
                    line: OrderLine
                    summary: OrderSummary
                }
            }
        `);

        expect(document.diagnostics?.filter(diagnostic =>
            String(diagnostic.message).includes('Data objects may contain value data')
        )).toHaveLength(2);
    });

    test('requires projector methods to declare targets and rejects projects on other methods', async () => {
        const document = await parse(`
            bounded context Commerce in bounded context Commerce {
                read model OrderSummary { orderId: string }
                event OrderPlaced
                projector OrderProjection {
                    method onOrderPlaced(source: OrderPlaced) {}
                }
                application service OrderApplication {
                    method publish() { projects OrderSummary }
                }
            }
        `);

        const errors = semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1).map(diagnostic => String(diagnostic.message));
        expect(errors).toContain('A projector method must declare at least one read model with projects.');
        expect(errors).toContain('The projects clause is allowed only in projector methods.');
    });

    test('validates CQRS read dependencies by method owner and supports query-repository table sources', async () => {
        const document = await parse(`bounded context Ordering in bounded context Ordering {
            aggregate Order {
                root entity Order {
                    identifier id: OrderId
                    method invalidRead() { reads from OrderRepository }
                }
                value object OrderId { raw: string }
            }
            repository OrderRepository {
                manages Order.Order
            }
            read model OrderSummary { status: string }
            query repository OrderSummaryRepository {
                serves OrderSummary
                reads from Order
            }
            application service Commands {
                method place() { reads from OrderRepository }
                method invalidQueryRead() { reads from OrderSummaryRepository }
            }
            query service Queries {
                method find() returns OrderSummary { reads from OrderSummaryRepository }
                method invalidAggregateRead() returns OrderSummary { reads from OrderRepository }
            }
            domain service Eligibility {
                method check() { reads from OrderRepository }
                method invalidQueryRead() { reads from OrderSummaryRepository }
            }
            event OrderPlaced
            projector OrderProjector {
                method onOrderPlaced(source: OrderPlaced) {
                    reads from OrderRepository when "The event needs current customer details."
                    projects OrderSummary
                }
                method invalidQueryRead(source: OrderPlaced) {
                    reads from OrderSummaryRepository
                    projects OrderSummary
                }
            }
        }`);
        const diagnostics = semanticDiagnostics(document);
        const errors = diagnostics.filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Error)
            .map(diagnostic => String(diagnostic.message));
        expect(errors).toContain('An application-service method must use command-side repositories, not query repositories.');
        expect(errors).toContain('A query service may read only query repositories in its own bounded context.');
        expect(errors).toContain('A domain service must not depend on a query repository; use a domain repository or port.');
        expect(errors).toContain('A projector must not read from a query repository; use event data or an explicit aggregate/reference source.');
        expect(diagnostics.some(diagnostic => diagnostic.severity === DiagnosticSeverity.Warning &&
            String(diagnostic.message).includes('may produce different results when events are replayed'))).toBe(true);
        expect(errors).not.toContain('A query repository may read aggregate table data only from its own bounded context.');
        const invalidRead = diagnostics.find(diagnostic => String(diagnostic.message).includes(
            'The reads from clause is allowed only in application-service, query-service, projector, or domain-service methods.'
        ));
        expect(invalidRead).toBeDefined();
        const invalidReadSource = document.textDocument.getText();
        const invalidReadsOffset = invalidReadSource.indexOf('reads from OrderRepository', invalidReadSource.indexOf('method invalidRead'));
        expect(document.textDocument.offsetAt(invalidRead!.range.start)).toBe(invalidReadsOffset);
        expect(document.textDocument.offsetAt(invalidRead!.range.end)).toBe(invalidReadsOffset + 'reads from'.length);
    });

    test('underlines method effects that are not allowed for their owner', async () => {
        const source = `bounded context Ordering in bounded context Ordering {
            aggregate OrderAggregate {
                root entity Order {
                    method place() { transition status from Draft to Placed }
                    identifier id: OrderId
                    status: OrderStatus
                }
                value object OrderId { raw: string }
                enum OrderStatus { Draft, Placed }
            }
            event OrderPlaced
            read model OrderSummary { status: OrderStatus }
            application service Commands {
                method publish() { emits OrderPlaced }
                method project() { projects OrderSummary }
                method changeStatus() { transition status from Draft to Placed }
            }
            query service Queries {
                method find() returns string { emits OrderPlaced }
            }
            domain service Pricing { method calculate() returns decimal }
            projector OrderProjector {
                method project(source: OrderPlaced) { invokes Pricing.calculate }
                method returnValue(source: OrderPlaced) returns string { projects OrderSummary }
            }
        }`;
        const document = await parse(source);
        const assertKeywordUnderline = (message: string, clause: string, keyword: string) => {
            const diagnostic = semanticDiagnostics(document).find(candidate => String(candidate.message) === message);
            expect(diagnostic, message).toBeDefined();
            expect(document.textDocument.offsetAt(diagnostic!.range.start)).toBe(source.indexOf(keyword, source.indexOf(clause)));
        };

        assertKeywordUnderline(
            'Only aggregate-root behavior may emit domain events, and only a domain-event handler may emit integration events.',
            'method publish()',
            'emits'
        );
        assertKeywordUnderline(
            'The projects clause is allowed only in projector methods.',
            'method project() { projects',
            'projects'
        );
        assertKeywordUnderline(
            'A state transition must be declared in an entity method inside an aggregate.',
            'method changeStatus()',
            'transition'
        );
        assertKeywordUnderline(
            'A query cannot emit events.',
            'method find()',
            'emits'
        );
        assertKeywordUnderline(
            'Projector methods cannot invoke other methods.',
            'method project(source: OrderPlaced)',
            'invokes'
        );
        assertKeywordUnderline(
            'A projector handler does not return a value.',
            'method returnValue',
            'returns'
        );

        const incompleteQueryEmission = await parse(`bounded context Ordering in bounded context Ordering {
            query service Queries {
                method find() returns string { emits
            }
        }`);
        const incompleteEmissionDiagnostic = semanticDiagnostics(incompleteQueryEmission).find(diagnostic =>
            String(diagnostic.message) === 'A query cannot emit events.'
        );
        expect(incompleteEmissionDiagnostic).toBeDefined();
        expect(incompleteQueryEmission.textDocument.offsetAt(incompleteEmissionDiagnostic!.range.start)).toBe(
            incompleteQueryEmission.textDocument.getText().indexOf('emits')
        );
    });

    test('allows domain services to invoke only other domain services', async () => {
        const document = await parse(`bounded context Ordering in bounded context Ordering {
            aggregate OrderAggregate {
                root entity Order { identifier id: OrderId }
                value object OrderId { raw: string }
            }
            factory OrderFactory { method create() returns Order }
            query service Queries { method find() returns string }
            domain service Pricing {
                method calculate() { invokes Queries.find }
                method createOrder() { invokes OrderFactory.create }
            }
        }`);

        const domainServiceInvocationErrors = semanticDiagnostics(document).filter(diagnostic =>
            String(diagnostic.message) === 'A domain service may invoke only another domain service.'
        );
        expect(domainServiceInvocationErrors).toHaveLength(1);
        const source = document.textDocument.getText();
        expect(domainServiceInvocationErrors.map(diagnostic =>
            document.textDocument.offsetAt(diagnostic.range.start)
        )).toEqual(expect.arrayContaining([
            source.indexOf('Queries.find') + 'Queries.'.length
        ]));
        const factoryInvocationErrors = semanticDiagnostics(document).filter(diagnostic =>
            String(diagnostic.message) === 'Only an application service may invoke a factory method.'
        );
        expect(factoryInvocationErrors).toHaveLength(1);
        expect(document.textDocument.offsetAt(factoryInvocationErrors[0]!.range.start)).toBe(
            source.indexOf('OrderFactory.create') + 'OrderFactory.'.length
        );
    });

    test('rejects more than one write repository for an aggregate', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                repository FirstOrderRepository {
                    manages Order.Order
                }
                repository SecondOrderRepository {
                    manages Order.Order
                }
            }
        `);

        const duplicate = document.diagnostics?.find(diagnostic =>
            diagnostic.code === 'duplicate-write-repository'
        );
        expect(duplicate).toBeDefined();
        expect(String(duplicate?.message)).toContain("Aggregate 'Order'");
        expect(String(duplicate?.message)).toContain('write repository');
        expect(String(duplicate?.message)).toContain("'FirstOrderRepository'");
        expect(String(duplicate?.message)).toContain("'SecondOrderRepository'");
    });

    test('requires a write repository to manage an aggregate-root entity', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                    entity OrderLine { identifier id: OrderLineId }
                    value object OrderLineId { raw: string }
                }
                repository OrderLineRepository {
                    manages Order.OrderLine
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes('A repository must manage an aggregate-root entity.')
        )).toBe(true);
    });

    test('allows application services to invoke factory methods without repository choreography', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                repository OrderRepository {
                    manages Order.Order
                }
                factory OrderFactory {
                    method createOrder(id: OrderId) returns Order.Order
                    }
                application service OrderApplication {
                    method createOrder(id: OrderId) {
                        invokes OrderFactory.createOrder
                    }
                }
            }
        `);

        expect(checkDocumentValid(document) || semanticDiagnostics(document).map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('rejects a factory that creates different aggregate roots with different methods', async () => {
        const document = await parse(`
            bounded context Commerce in bounded context Commerce {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                aggregate Customer {
                    root entity Customer { identifier id: CustomerId }
                    value object CustomerId { raw: string }
                }
                factory CommerceFactory {
                    method createOrder(id: OrderId) returns Order.Order
                    method createCustomer(id: CustomerId) returns Customer.Customer
                }
            }
        `);

        expect(document.parseResult.parserErrors).toHaveLength(0);
        expect(semanticDiagnostics(document).some(diagnostic =>
            diagnostic.code === 'multiple-factory-roots' &&
            String(diagnostic.message).includes('A factory must create one aggregate root')
        )).toBe(true);
    });

    test('allows a factory to create one aggregate root with multiple methods', async () => {
        const document = await parse(`
            bounded context Commerce in bounded context Commerce {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                factory OrderFactory {
                    method create(id: OrderId) returns Order.Order
                    method reconstitute(id: OrderId) returns Order.Order
                }
            }
        `);

        expect(document.parseResult.parserErrors).toHaveLength(0);
        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1)).toHaveLength(0);
    });

    test('allows read queries and descriptive delete commands without repository choreography', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method validateDeletion()
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                }
                repository OrderRepository {
                    manages Order.Order
                }
                read model OrderReadModel { status: string }
                query repository OrderReadModelRepository {
                    serves OrderReadModel
                }
                application service OrderApplication {
                    method deleteOrder(id: OrderId) {
                        invokes Order.Order.validateDeletion
                        behavior "Delete the order when its root confirms deletion is allowed."
                    }
                }
                query service OrderQueries {
                    method getOrder(id: OrderId) returns string {
                        behavior "Read [[OrderReadModelRepository]] for the requested order."
                    }
                }
            }
        `);

        expect(checkDocumentValid(document) || semanticDiagnostics(document).map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('rejects query services that read from aggregate repositories', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place()
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                }
                repository OrderRepository {
                    manages Order.Order
                }
                query service OrderQueries {
                    method getStatus(id: OrderId) returns string {
                        reads from OrderRepository
                        behavior "Read the status for [[id]] from the order summary."
                    }
                }
            }
        `);

        expect(semanticDiagnostics(document).some(diagnostic =>
            String(diagnostic.message).includes('A query service may read only query repositories')
        )).toBe(true);
    });

    test('allows integration-event handlers without an after-commit clause', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order { root entity Order { identifier id: OrderId } value object OrderId { raw: string } }
                event OrderPlaced
                integration event OrderPlacedV1
                application service OrderApplication {
                    method publish(source: OrderPlaced) {
                        emits OrderPlacedV1
                    }
                }
            }
        `);

        expect(checkDocumentValid(document) || semanticDiagnostics(document).map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('rejects an integration-event payload that exposes an entity', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                value object InternalOrderCode { raw: string }
                integration event OrderPlaced {
                    order: Order
                    orderId: OrderId
                    code: InternalOrderCode
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Event payloads must not expose entity instances'
        ))).toBe(true);
        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An integration-event payload must not expose types owned by an aggregate.'
        ))).toBe(true);
        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Integration-event payload types must be public contract types'
        ))).toBe(false);
    });

    test('allows context-level integration-event payload types', async () => {
        const document = await parse(`
            bounded context Shop
            in bounded context Shop {
                value object Payload {
                    raw: string
                }
                integration event Published {
                    payload: Payload
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('rejects nested aggregate-owned and private integration-event payload types', async () => {
        const document = await parse(`
            bounded context Shop
            in bounded context Shop {
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId
                    }
                    value object OrderId {
                        raw: string
                    }
                }
                module Contracts {
                    exposes E, PublicInfo
                    value object PublicInfo {
                        id: OrderId
                        secret: Secret
                    }
                    value object Secret {
                        raw: string
                    }
                    integration event E {
                        info: PublicInfo
                    }
                }
            }
        `);

        const messages = semanticDiagnostics(document).map(diagnostic => diagnostic.message);
        expect(messages).toContain('An integration-event payload must not expose types owned by an aggregate.');
        expect(messages).toContain('Integration-event payload types must be public contract types exposed by their module and all enclosing modules; context-level types are public.');
    });

    test('reports one module diagnostic for a private integration-event payload type', async () => {
        const document = await parse(`
            bounded context Shop
            in bounded context Shop {
                module Outer {
                    module Inner {
                        value object Payload {
                            raw: string
                        }
                    }
                }
                module Contracts {
                    integration event E {
                        payload: Outer.Inner.Payload
                    }
                }
            }
        `);
        const messages = semanticDiagnostics(document)
            .filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Error)
            .map(diagnostic => String(diagnostic.message));
        expect(messages.filter(message =>
            message === 'Integration-event payload types must be public contract types exposed by their module and all enclosing modules; context-level types are public.'
        )).toHaveLength(1);
        expect(messages).not.toContain('This module reference requires a dependency on a module that exposes the target declaration.');
    });

    test('rejects entities and aggregate-owned types inside event payload collections', async () => {
        const document = await parse(`
            bounded context Shop
            in bounded context Shop {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                    value object Line { raw: string }
                    entity Item { identifier id: ItemId }
                    value object ItemId { raw: string }
                }
                integration event IntegrationPayload {
                    lines: List<Order.Line>
                    items: Set<Order.Item>
                }
                event DomainPayload {
                    items: List<Order.Item>
                }
            }
        `);

        const messages = semanticDiagnostics(document).map(diagnostic => String(diagnostic.message));
        expect(messages).toContain('An integration-event payload must not expose types owned by an aggregate.');
        expect(messages).toContain('Event payloads must not expose entity instances; use stable value data instead.');
    });

    test('rejects aggregate-owned and private types inside nested event payload collections', async () => {
        const document = await parse(`
            bounded context Shop
            in bounded context Shop {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                    value object Line { raw: string }
                }
                module Contracts {
                    exposes IntegrationPayload, Payload
                    value object Payload {
                        lines: List<Order.Line>
                    }
                    integration event IntegrationPayload {
                        payload: Payload
                    }
                }
            }
        `);

        const messages = semanticDiagnostics(document).map(diagnostic => String(diagnostic.message));
        expect(messages).toContain('An integration-event payload must not expose types owned by an aggregate.');
    });

    test('rejects private module types inside event payload collections', async () => {
        const document = await parse(`
            bounded context Shop
            in bounded context Shop {
                module Outer {
                    module Inner {
                        exposes Payload
                        value object Payload { raw: string }
                    }
                }
                module Contracts {
    depends on Outer.Inner

                    exposes E
                    integration event E {
                        items: List<Inner.Payload>
                    }
                }
            }
        `);

        expect(semanticDiagnostics(document).map(diagnostic => String(diagnostic.message))).toContain(
            'Integration-event payload types must be public contract types exposed by their module and all enclosing modules; context-level types are public.'
        );
    });

    test('allows public value-object collections in event payloads', async () => {
        const document = await parse(`
            bounded context Shop
            in bounded context Shop {
                value object PayloadLine { raw: string }
                integration event IntegrationPayload {
                    lines: List<PayloadLine>
                }
                event DomainPayload {
                    lines: Map<string, List<PayloadLine>>
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('rejects entities hidden in a nested integration-event payload value object', async () => {
        const document = await parse(`
            bounded context Shop
            in bounded context Shop {
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId
                    }
                    value object OrderId {
                        raw: string
                    }
                    value object OrderRef {
                        order: Order
                    }
                }
                module Contracts {
                    exposes E, Payload
                    value object Payload {
                        ref: OrderRef
                    }
                    integration event E {
                        payload: Payload
                    }
                }
            }
        `);

        expect(semanticDiagnostics(document).map(diagnostic => diagnostic.message)).toContain(
            'Event payloads must not expose entity instances; use stable value data instead.'
        );
    });

    test('rejects entities hidden in a value object nested by a data object or read model', async () => {
        const document = await parse(`
            bounded context Shop
            in bounded context Shop {
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId
                    }
                    value object OrderId {
                        raw: string
                    }
                    value object OrderRef {
                        order: Order
                    }
                }
                data object Dto {
                    ref: OrderRef
                }
                read model Summary {
                    ref: OrderRef
                }
            }
        `);

        const messages = semanticDiagnostics(document).map(diagnostic => diagnostic.message);
        expect(messages).toContain('Data objects may contain value data, but not entities or read models.');
        expect(messages).toContain('Read models must project data rather than reference entity instances.');
    });

    test('rejects entities hidden in application-service and factory signatures', async () => {
        const document = await parse(`
            bounded context Shop
            in bounded context Shop {
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId
                    }
                    value object OrderId {
                        raw: string
                    }
                    value object OrderRef {
                        order: Order
                    }
                }
                application service App {
                    method use(ref: OrderRef) {}
                }
                factory OrderFactory {
                    method create(ref: OrderRef) returns Order.Order
                }
            }
        `);

        const messages = semanticDiagnostics(document).map(diagnostic => diagnostic.message);
        expect(messages.filter(message =>
            message === 'Application-service signatures must use identifiers or data values, not entity instances.'
        )).toHaveLength(1);
        expect(messages.filter(message =>
            message === 'Factory method signatures must use identifiers or domain values, not entity instances.'
        )).toHaveLength(1);
    });

    test('resolves nested canonical specification field paths', async () => {
        const document = await parse(`
            bounded context Shop
            in bounded context Shop {
                value object Address {
                    city: string
                }
                data object Dto {
                    address: Address
                }
                application service App {
                    method handle() {
                        behavior "[[Shop.Dto.address.city]]."
                    }
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic =>
            String(diagnostic.message).includes('Could not resolve reference')
        )).toEqual([]);
    });

    test('resolves entity fields from specification result and parameter roots', async () => {
        const document = await parse(`
            bounded context Shop
            in bounded context Shop {
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId
                        status: OrderStatus
                        method check() returns Order {
                            behavior "[[result.status]]."
                        }
                    }
                    value object OrderId {
                        raw: string
                    }
                    enum OrderStatus {
                        Draft,
                        Done
                    }
                }
                domain service Policy {
                    method inspect(order: Order.Order) {
                        behavior "[[order.status]]."
                    }
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic =>
            String(diagnostic.message).includes('Could not resolve reference')
        )).toEqual([]);
    });

    test('resolves nested canonical fields in journey prose', async () => {
        const document = await parse(`
            bounded context Shop
            in bounded context Shop {
                value object Address {
                    city: string
                }
                module Contracts {
                    exposes E, Address
                    integration event E {
                        address: Address
                    }
                }
                application service App {
                    method run() {}
                }
            }
            actor User
            journey CheckEvent {
                by User {
                    invoke Shop.App.run
                        when "[[Shop.Contracts.E.address.city]]."
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic =>
            String(diagnostic.message).includes('Could not resolve reference')
        )).toEqual([]);
    });

    test('distinguishes optional and required constructor signatures', async () => {
        const document = await parse(`
            bounded context Shop
            in bounded context Shop {
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId
                        constructor(name?: string) {}
                        constructor(name: string) {}
                    }
                    value object OrderId {
                        raw: string
                    }
                }
            }
        `);

        expect(semanticDiagnostics(document).some(diagnostic =>
            diagnostic.message === 'Duplicate constructor signature.'
        )).toBe(false);
    });

    test('does not report initial-state or optional-identifier errors while typing', async () => {
        const initialDocument = await parse(`
            bounded context Shop
            in bounded context Shop {
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId
                        status: OrderStatus initial D
                    }
                    value object OrderId {
                        raw: string
                    }
                    enum OrderStatus {
                        Draft,
                        Done
                    }
                }
            }
        `);
        expect(semanticDiagnostics(initialDocument).some(diagnostic =>
            String(diagnostic.message).includes('An initial state must be a declared value')
        )).toBe(false);

        const identifierDocument = await parse(`
            bounded context Shop
            in bounded context Shop {
                aggregate Order {
                    root entity Order {
                        identifier id?
                    }
                    value object OrderId {
                        raw: string
                    }
                }
            }
        `);
        expect(semanticDiagnostics(identifierDocument).some(diagnostic =>
            String(diagnostic.message).includes('cannot be optional') ||
            String(diagnostic.message).includes('must reference a value object')
        )).toBe(false);
    });

    test('accepts integration-event payload types explicitly exposed by their contract module', async () => {
        const document = await parse(`
            bounded context Shipping in bounded context Shipping {
                module Contracts {
                    exposes OrderPlacedV1, OrderReference
                    value object OrderReference { raw: string }
                    integration event OrderPlacedV1 { order: OrderReference }
                }
            }
        `);

        expect(checkDocumentValid(document) || semanticDiagnostics(document).map(diagnosticToString).join('\n')).toHaveLength(0);
    });

    test('requires a dependency for a direct integration-event payload type in a sibling module', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                module Types {
                    exposes Payload
                    value object Payload { raw: string }
                }
                module Contracts {
                    exposes E
                    integration event E { payload: Payload }
                }
            }
        `);

        expect(semanticDiagnostics(document).some(diagnostic =>
            String(diagnostic.message) === 'This module reference requires a dependency on a module that exposes the target declaration.'
        )).toBe(true);
    });

    test('accepts a direct integration-event payload type through a module dependency', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                module Types {
                    exposes Payload
                    value object Payload { raw: string }
                }
                module Contracts {
    depends on Types

                    exposes E
                    integration event E { payload: Payload }
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('requires module-nested integration events to be exposed before cross-context use', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                module Contracts {
                    integration event OrderPlacedV1
                }
            }
            bounded context Shipping in bounded context Shipping {
                aggregate Shipment {
                    root entity Shipment { identifier id: ShipmentId }
                    value object ShipmentId { raw: string }
                }
                application service ShipmentEvents {
                    method onOrderPlaced(source: Ordering.Contracts.OrderPlacedV1) {}
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An integration event in a module must be exposed by its module and every enclosing module'
        ))).toBe(true);
    });

    test('rejects event publication from a context-level domain service', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                domain service OrderPolicy {
                    method check() { emits OrderPlaced }
                }
                event OrderPlaced
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Only aggregate-root behavior may emit domain events'
        ))).toBe(true);
    });

    test('rejects integration-event publication from aggregate-root behavior', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place() { emits OrderPlacedV1 }
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                }
                integration event OrderPlacedV1
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Aggregate-root behavior may emit only domain events.'
        ))).toBe(true);
    });

    test('prevents application services from invoking cross-context aggregates', async () => {
        const ordering = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering.tni'),
            'bounded context Ordering in bounded context Ordering { aggregate Order { root entity Order { method place() identifier id: OrderId } value object OrderId { raw: string } } }'
        );
        const shipping = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shipping.tni'),
            'import "./ordering.tni" bounded context Shipping in bounded context Shipping { application service ShippingApplication { method place() { invokes Ordering.Order.Order.place when "The order is ready." } } }'
        );
        documents = [ordering, shipping];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(
            checkDocumentValid(shipping) || semanticDiagnostics(shipping).map(diagnosticToString).join('\n')
        ).toEqual(expect.stringContaining('A method may invoke across bounded-context boundaries only through an authorized shared-kernel domain service.'));
    });

    test('rejects duplicate canonical context declarations', async () => {
        const first = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering-one.tni'),
            'bounded context Ordering'
        );
        const second = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/ordering-two.tni'),
            'import "./ordering-one.tni"\nbounded context Ordering'
        );
        documents = [first, second];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(second.diagnostics?.some(diagnostic => diagnostic.message === "Duplicate declaration 'Ordering'.")).toBe(true);
    });

    test('reports duplicates across imported files from a root model', async () => {
        const first = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/root-duplicate-one.tni'),
            'bounded context RootDuplicate'
        );
        const second = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/root-duplicate-two.tni'),
            'bounded context RootDuplicate'
        );
        const root = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/root-duplicate-model.tni'),
            'import "./root-duplicate-one.tni"\nimport "./root-duplicate-two.tni"'
        );
        documents = [first, second, root];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(first.diagnostics?.some(diagnostic =>
            diagnostic.message === "Duplicate declaration 'RootDuplicate'."
        )).toBe(true);
        expect(second.diagnostics?.some(diagnostic =>
            diagnostic.message === "Duplicate declaration 'RootDuplicate'."
        )).toBe(true);
    });

    test('permits the same declaration name in independent models', async () => {
        const first = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/independent-one.tni'),
            'bounded context Independent'
        );
        const second = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/independent-two.tni'),
            'bounded context Independent'
        );
        documents = [first, second];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(first.diagnostics?.some(diagnostic => diagnostic.message === "Duplicate declaration 'Independent'.")).toBe(false);
        expect(second.diagnostics?.some(diagnostic => diagnostic.message === "Duplicate declaration 'Independent'.")).toBe(false);
    });

    test('reports a duplicate declaration added after an initial build', async () => {
        const first = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/incremental-duplicate-z.tni'),
            'bounded context IncrementalDuplicate'
        );
        documents = [first];
        await services.shared.workspace.DocumentBuilder.build([first], { validation: true });

        const second = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/incremental-duplicate-a.tni'),
            'import "./incremental-duplicate-z.tni"\nbounded context IncrementalDuplicate'
        );
        documents.push(second);
        await services.shared.workspace.DocumentBuilder.build([second], { validation: true });

        expect(second.diagnostics?.some(diagnostic =>
            diagnostic.message === "Duplicate declaration 'IncrementalDuplicate'."
        )).toBe(true);
    });

    test('keeps strategic declaration names separate from path declarations', async () => {
        const document = await parse(`
            subdomain Ordering kind core
            actor Ordering
            journey Ordering {
                by Ordering {
                    invoke Ordering.App.run
                }
            }
            bounded context Ordering realizes Ordering
            in bounded context Ordering {
                application service App {
                    method run()
                }
            }
        `);
        expect(semanticDiagnostics(document).filter(diagnostic =>
            String(diagnostic.message).startsWith("Duplicate declaration 'Ordering'")
        )).toEqual([]);
    });

    test('still rejects duplicate names within the same strategic namespace', async () => {
        const document = await parse(`
            actor Customer
            actor Customer
            subdomain Sales kind core
            subdomain Sales kind supporting
            journey Checkout { by Customer { invoke Ordering.App.run } }
            journey Checkout { by Customer { invoke Ordering.App.run } }
            bounded context Ordering
            in bounded context Ordering {
                application service App { method run() }
            }
        `);
        const duplicates = semanticDiagnostics(document)
            .filter(diagnostic => String(diagnostic.message).startsWith('Duplicate declaration'))
            .map(diagnostic => String(diagnostic.message));
        expect(duplicates.filter(message => message === "Duplicate declaration 'Customer'.")).toHaveLength(2);
        expect(duplicates.filter(message => message === "Duplicate declaration 'Sales'.")).toHaveLength(2);
        expect(duplicates.filter(message => message === "Duplicate declaration 'Checkout'.")).toHaveLength(2);
    });

    test('allows an import alias to match an operation parameter name', async () => {
        const other = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/alias-parameter-other.tni'),
            'bounded context Other'
        );
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/alias-parameter-consumer.tni'),
            `import { Other as input } from "./alias-parameter-other.tni"
            bounded context Consumer
            in bounded context Consumer {
                application service App {
                    method run(input: string)
                }
            }`
        );
        documents = [other, consumer];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
        expect(consumer.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes("Import alias 'input' conflicts")
        )).toBe(false);
    });

    test('does not let a component alias shadow strategic declarations', async () => {
        const other = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/alias-strategic-other.tni'),
            `bounded context Other
            in bounded context Other {
                application service App {
                    method run()
                }
            }`
        );
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/alias-strategic-consumer.tni'),
            `import { Other as Ordering } from "./alias-strategic-other.tni"
            subdomain Ordering kind core
            actor Ordering
            journey Checkout {
                by Ordering {
                    invoke Ordering.App.run
                }
            }
            bounded context Consumer realizes Ordering`
        );
        documents = [other, consumer];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
        expect(consumer.diagnostics?.filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('reports an alias that collides with an imported canonical declaration', async () => {
        const common = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/alias-canonical-common.tni'),
            'bounded context Common'
        );
        const ordering = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/alias-canonical-ordering.tni'),
            'bounded context Ordering'
        );
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/alias-canonical-consumer.tni'),
            `import "./alias-canonical-common.tni"
            import { Ordering as Common } from "./alias-canonical-ordering.tni"
            bounded context Consumer`
        );
        documents = [common, ordering, consumer];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
        expect(consumer.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes("Import alias 'Common' conflicts with an imported declaration")
        )).toBe(true);
    });

    test('does not navigate map keys through specification paths', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                value object Key {
                    keyField: string
                }
                value object Value {
                    valueField: string
                }
                application service App {
                    method use(input: Map<Key, Value>) {
                        behavior "Use [[input.keyField]] and [[input.valueField]]."
                    }
                }
            }
        `);
        expect(semanticDiagnostics(document).some(diagnostic =>
            String(diagnostic.message).includes("Could not resolve reference to SpecificationTarget named 'keyField'")
        )).toBe(true);
        expect(semanticDiagnostics(document).some(diagnostic =>
            String(diagnostic.message).includes("Could not resolve reference to SpecificationTarget named 'valueField'")
        )).toBe(false);
    });

    test('requires a shared-kernel relationship to name at least two contexts', async () => {
        const document = await parse(`
            bounded context Ordering
            shared kernel CommonTypes {}
            context map SharedTypes {
                sharedKernel CommonTypes { participants: [Ordering] }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'A shared-kernel relationship must include at least two bounded contexts'
        ))).toBe(true);
    });

    test('rejects duplicate relationships between a bounded-context pair in one context map', async () => {
        const document = await parse(`
            bounded context Ordering
            bounded context Shipping
            context map Fulfillment {
                customer Shipping -> supplier Ordering
                customer Shipping -> supplier Ordering
            }
        `);

        expect(document.diagnostics?.filter(diagnostic => String(diagnostic.message).includes(
            'may only be declared once in context map'
        ))).toHaveLength(1);
    });

    test('treats reversed symmetric relationships as duplicates in one context map', async () => {
        const document = await parse(`
            bounded context Ordering
            bounded context Shipping
            context map Fulfillment {
                partner Ordering <-> partner Shipping
                partner Shipping <-> partner Ordering
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'may only be declared once in context map'
        ))).toBe(true);
    });

    test('rejects conflicting relationship types for a pair in one context map', async () => {
        const document = await parse(`
            bounded context Ordering
            bounded context Shipping
            context map Fulfillment {
                partner Ordering <-> partner Shipping
                separateWays Shipping -x- Ordering
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Conflicting relationships between'
        ))).toBe(true);
    });

    test('rejects reciprocal customer-supplier directions for one pair in a context map', async () => {
        const document = await parse(`
            bounded context Ordering
            bounded context Shipping
            context map Fulfillment {
                customer Ordering -> supplier Shipping
                customer Shipping -> supplier Ordering
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Conflicting relationships between'
        ))).toBe(true);
    });

    test('allows a shared kernel to overlay a customer-supplier relationship', async () => {
        const document = await parse(`
            bounded context Ordering
            bounded context Shipping
            shared kernel CommonTypes {}
            context map FulfillmentMap {
                customer Shipping -> supplier Ordering
                sharedKernel CommonTypes { participants: [Ordering, Shipping] }
            }
        `);

        expect(document.diagnostics?.filter(diagnostic => String(diagnostic.message).includes(
            'relationship between'
        ))).toEqual([]);
    });

    test('rejects a separate-ways relationship paired with a shared kernel', async () => {
        const document = await parse(`
            bounded context Ordering
            bounded context Shipping
            shared kernel CommonTypes {}
            context map FulfillmentMap {
                separateWays Ordering -x- Shipping
                sharedKernel CommonTypes { participants: [Ordering, Shipping] }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'Conflicting relationships between'
        ))).toBe(true);
    });

    test('allows shared-kernel domain services but rejects data objects in shared-kernel modules', async () => {
        const valid = await parse(`
            shared kernel SharedValid {
                value object Money { amount: decimal }
                domain service PricingPolicy {
                    method normalize(money: Money) returns decimal
                }
                module Policies {
                    domain service TaxPolicy { method rate(amount: decimal) returns decimal }
                }
            }
        `);
        expect(semanticDiagnostics(valid).filter(diagnostic => diagnostic.severity === 1).map(diagnostic => diagnostic.message)).toEqual([]);

        const invalid = await parse(`
            shared kernel SharedInvalid {
                module Payloads {
                    data object Address { street: string }
                }
            }
        `);
        expect(invalid.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'A shared kernel may contain only reusable value objects, enums, domain services, and modules.'
        ))).toBe(true);

        const coLocated = await parse(`
            bounded context Ordering in bounded context Ordering {
                application service OrderApplication {
                    method normalize(amount: decimal) returns decimal { invokes Common.PricingPolicy.normalize }
                }
            }
            bounded context Shipping
            shared kernel Common {
                domain service PricingPolicy { method normalize(amount: decimal) returns decimal }
            }
            context map SharedPolicies {
                sharedKernel Common { participants: [Ordering, Shipping] }
            }
        `);
        expect(semanticDiagnostics(coLocated).filter(diagnostic => diagnostic.severity === 1).map(diagnostic => diagnostic.message)).toEqual([]);
    });

    test('allows application services to invoke an imported shared-kernel service for participating contexts', async () => {
        const shared = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shared-policy-kernel.tni'),
            'shared kernel Common { domain service PricingPolicy { method normalize(amount: decimal) returns decimal } }'
        );
        const contexts = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shared-policy-contexts.tni'),
            'bounded context Ordering bounded context Shipping'
        );
        const map = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shared-policy-map.tni'),
            'import "./shared-policy-kernel.tni" import "./shared-policy-contexts.tni" context map SharedPolicies { sharedKernel Common { participants: [Ordering] } }'
        );
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shared-policy-consumer.tni'),
            `import "./shared-policy-contexts.tni"
             import { Common } from "./shared-policy-kernel.tni"
             import { SharedPolicies } from "./shared-policy-map.tni"
             in bounded context Ordering {
                 application service OrderApplication {
                     method normalize(amount: decimal) returns decimal { invokes Common.PricingPolicy.normalize }
                 }
             }`
        );
        const nonParticipant = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/shared-policy-nonparticipant.tni'),
            `import "./shared-policy-contexts.tni"
             import { Common } from "./shared-policy-kernel.tni"
             import { SharedPolicies } from "./shared-policy-map.tni"
             in bounded context Shipping {
                 application service ShippingApplication {
                     method normalize(amount: decimal) returns decimal { invokes Common.PricingPolicy.normalize }
                 }
             }`
        );
        documents = [shared, contexts, map, consumer, nonParticipant];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(semanticDiagnostics(consumer).filter(diagnostic => diagnostic.severity === 1).map(diagnostic => diagnostic.message)).toEqual([]);
        expect(nonParticipant.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'A method may invoke across bounded-context boundaries only through an authorized shared-kernel domain service.'
        ))).toBe(true);
    });

    test('rejects shared-kernel service calls without an imported relationship', async () => {
        const shared = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/unlinked-shared-policy-kernel.tni'),
            'shared kernel Common { domain service PricingPolicy { method normalize(amount: decimal) returns decimal } }'
        );
        const contexts = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/unlinked-shared-policy-contexts.tni'),
            'bounded context Ordering'
        );
        const consumer = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/unlinked-shared-policy-consumer.tni'),
            `import "./unlinked-shared-policy-contexts.tni"
             import { Common } from "./unlinked-shared-policy-kernel.tni"
             in bounded context Ordering {
                 application service OrderApplication {
                     method normalize(amount: decimal) returns decimal { invokes Common.PricingPolicy.normalize }
                 }
             }`
        );
        documents = [shared, contexts, consumer];
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(consumer.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'A method may invoke across bounded-context boundaries only through an authorized shared-kernel domain service.'
        ))).toBe(true);
    });

    test('rejects duplicate integration patterns on a context-map endpoint', async () => {
        const document = await parse(`
            bounded context Ordering
            bounded context Shipping
            context map Fulfillment {
                customer Shipping { integrationPatterns: ["AntiCorruptionLayer", "AntiCorruptionLayer"] }
                    -> supplier Ordering
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            'An integration pattern may only be listed once per bounded context'
        ))).toBe(true);
    });

    test('rejects unknown integration pattern labels', async () => {
        const document = await parse(`
            bounded context Ordering
            bounded context Shipping
            context map Fulfillment {
                customer Shipping { integrationPatterns: ["AntiCorruptionLayre"] }
                    -> supplier Ordering
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes(
            "Unknown integration pattern 'AntiCorruptionLayre'"
        ))).toBe(true);
    });

    test('underlines the unknown integration pattern rather than the whole pattern list', async () => {
        const source = `bounded context Ordering
bounded context Shipping
context map Fulfillment {
    customer Shipping { integrationPatterns: ["PublishedLanguage", "Bogus"] }
        -> supplier Ordering
}`;
        const document = await parse(source);
        const diagnostic = semanticDiagnostics(document).find(candidate =>
            String(candidate.message).includes("Unknown integration pattern 'Bogus'")
        );
        expect(diagnostic).toBeDefined();
        expect(document.textDocument.getText(diagnostic!.range)).toContain('Bogus');
    });

    test('requires map collections to declare both key and value types', async () => {
        const document = await parse(`
            bounded context Inventory in bounded context Inventory {
                value object InventoryIndex {
                    entries: Map<string>
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes('Map type requires both a key and a value type'))).toBe(true);
    });

    test('rejects duplicate dependency, exposure, projection, and realization entries', async () => {
        const modules = await parse(`
            bounded context Alpha
            in bounded context Alpha {
                module Dependency {
                    value object External { raw: string }
                }
                module Main {
    depends on Dependency, Dependency

                    exposes Value, Value
                    value object Value { raw: string }
                }
            }
        `);
        const moduleMessages = semanticDiagnostics(modules).map(diagnostic => diagnostic.message);
        expect(moduleMessages).toContain("Module dependency 'Dependency' is listed more than once.");
        expect(moduleMessages).toContain("Declaration 'Value' is exposed more than once.");

        const projections = await parse(`
            bounded context Alpha
            in bounded context Alpha {
                read model Summary { state: string }
                event Changed
                projector Projection {
                    method onChange(source: Changed) {
                        projects Summary, Summary
                    }
                }
            }
        `);
        expect(semanticDiagnostics(projections).map(diagnostic => diagnostic.message)).toContain(
            "Read model 'Summary' is referenced more than once in projects."
        );

        const realizations = await parse(`
            subdomain Shared kind core
            bounded context Alpha realizes Shared, Shared
        `);
        expect(semanticDiagnostics(realizations).map(diagnostic => diagnostic.message)).toContain(
            "Subdomain 'Shared' is realized more than once."
        );
    });

    test('reports a shared-kernel module depending on a bounded-context module', async () => {
        const document = await parse(`
            shared kernel Common {
                module Client {
    depends on Ordering.Internal

                    value object ClientCode { raw: string }
                }
            }
            bounded context Ordering
            in bounded context Ordering {
                module Internal {
                    value object InternalCode { raw: string }
                }
            }
        `);

        expect(semanticDiagnostics(document).map(diagnostic => diagnostic.message)).toContain(
            "A shared kernel cannot depend on a bounded context's private model."
        );
    });

    test('requires context-level references to module declarations to use exposed members', async () => {
        const document = await parse(`
            bounded context Example in bounded context Example {
                module Private {
                    value object PrivateCode {
                        raw: string
                    }
                }
                module Public {
                    exposes PublicCode
                    value object PublicCode {
                        raw: string
                    }
                }
                value object RootCode {
                    raw: string
                }
                module Consumer {
                    data object ModuleUse {
                        code: RootCode
                    }
                }
                value object RootUsePrivate {
                    code: PrivateCode
                }
                value object RootUsePublic {
                    code: PublicCode
                }
            }
        `);
        const visibilityErrors = document.diagnostics?.filter(diagnostic =>
            String(diagnostic.message).includes('A declaration outside a module may reference a module declaration only when its module and all enclosing modules expose it.')
        ) ?? [];
        expect(visibilityErrors).toHaveLength(1);
    });

    test('requires a dependency for a type in a sibling module', async () => {
        const missingDependency = await parse(`
            bounded context C
            in bounded context C {
                module Types {
                    exposes Code
                    value object Code { raw: string }
                }
                module Consumer {
                    value object UsesCode {
                        code: Code
                    }
                }
            }
        `);

        expect(semanticDiagnostics(missingDependency).map(diagnostic => String(diagnostic.message)))
            .toContain('This module reference requires a dependency on a module that exposes the target declaration.');

        const missingExposure = await parse(`
            bounded context E
            in bounded context E {
                module Types {
                    value object Code { raw: string }
                }
                module Consumer {
    depends on Types

                    value object UsesCode {
                        code: Code
                    }
                }
            }
        `);

        expect(semanticDiagnostics(missingExposure).map(diagnostic => String(diagnostic.message)))
            .toContain('This module reference requires a dependency on a module that exposes the target declaration.');

        const valid = await parse(`
            bounded context D
            in bounded context D {
                module Types {
                    exposes Code
                    value object Code { raw: string }
                }
                module Consumer {
    depends on Types

                    value object UsesCode {
                        code: Code
                    }
                }
            }
        `);

        expect(semanticDiagnostics(valid).filter(diagnostic =>
            diagnostic.severity === DiagnosticSeverity.Error
        )).toEqual([]);
    });

    test('exposes declarations only, not their fields or enum values', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                module Contracts {
                    exposes OrderId.raw
                    value object OrderId { raw: string }
                }
            }
        `);

        const messages = (document.diagnostics ?? []).map(diagnostic => String(diagnostic.message));
        expect(messages.some(message => message.includes("ExposableDeclaration named 'raw'"))).toBe(true);
    });

    test('rejects circular module dependencies', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                module Orders {
    depends on Pricing
}
                module Pricing {
    depends on Orders
}
            }
        `);

        expect(document.diagnostics?.some(diagnostic => String(diagnostic.message).includes('Module dependencies cannot contain a cycle'))).toBe(true);
    });

    test('accepts bodyless bounded-context declarations and imported contributions', async () => {
        const canonical = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/canonical-context.tni'),
            'subdomain OrderManagement kind core bounded context Ordering realizes OrderManagement'
        );
        const directImport = services.shared.workspace.LangiumDocuments.createDocument(
            URI.file('/workspace/direct-context-import.tni'),
            'import "./canonical-context.tni" in bounded context Ordering { event OrderPlaced }'
        );
        documents = [canonical, directImport];

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        expect(canonical.parseResult.parserErrors).toHaveLength(0);
        expect(semanticDiagnostics(directImport).filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('does not crash while a bounded-context contribution has no context name', async () => {
        const document = await parse(`
            in bounded context {
                aggregate Sample {
                    root entity Sample { identifier id: SampleId }
                    value object SampleId { raw: string }
                }
            }
        `);

        expect(document.diagnostics?.some(diagnostic =>
            String(diagnostic.message).startsWith('An error occurred during validation')
        )).toBe(false);
        expect(document.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes('An `in bounded context` clause needs a bounded context name.')
        )).toBe(true);
        expect(document.diagnostics?.some(diagnostic =>
            String(diagnostic.message).includes("Expecting token of type 'ID'")
        )).toBe(false);
    });

    test('rejects another aggregate root in an entity method signature', async () => {
        const document = await parse(`
            bounded context Shop
            in bounded context Shop {
                aggregate Order {
                    root entity Order {
                        method inspect(other: Customer) returns Customer
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                }
                aggregate Customer {
                    root entity Customer { identifier id: CustomerId }
                    value object CustomerId { raw: string }
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic =>
            diagnostic.message === 'Reference another aggregate by its identifier, not by passing its entity instance.'
        )).toHaveLength(2);
    });

    test('restricts factory and query-service invocation targets', async () => {
        const document = await parse(`
            bounded context Shop
            in bounded context Shop {
                aggregate Order {
                    root entity Order {
                        method place() {
                            invokes OrderFactory.createOrder
                            invokes Reports.lookup
                        }
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                }
                aggregate Customer {
                    root entity Customer { identifier id: CustomerId }
                    value object CustomerId { raw: string }
                }
                factory OrderFactory { method createOrder() returns Order.Order }
                query service Reports { method lookup() returns string }
            }
        `);

        const messages = semanticDiagnostics(document).map(diagnostic => diagnostic.message);
        expect(messages).toContain('Only an application service may invoke a factory method.');
        expect(messages).toContain('Only a query service may invoke a query-service method.');
    });

    test('rejects optional event-handler parameters', async () => {
        const document = await parse(`
            bounded context Shop
            in bounded context Shop {
                event OrderPlaced
                module Contracts {
                    exposes OrderPlacedV1
                    integration event OrderPlacedV1 { orderId: string }
                }
                application service App {
                    method publish(source?: OrderPlaced) { emits Contracts.OrderPlacedV1 }
                }
            }
        `);

        expect(semanticDiagnostics(document).some(diagnostic =>
            diagnostic.message === 'An event-triggered parameter cannot be optional.'
        )).toBe(true);
    });

    test('rejects duplicate entries in effect and journey lists', async () => {
        const document = await parse(`
            bounded context Shop
            in bounded context Shop {
                aggregate Order {
                    root entity Order {
                        method place() { emits OrderPlaced, OrderPlaced }
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                }
                event OrderPlaced
                repository OrderRepository { manages Order.Order }
                application service App {
                    method run() { reads from OrderRepository, OrderRepository }
                }
            }
            actor Customer
            journey PlaceOrder {
                by Customer { invoke Shop.App.run }
                by Customer { invoke Shop.App.run }
            }
        `);

        const messages = semanticDiagnostics(document).map(diagnostic => diagnostic.message);
        expect(messages).toContain("Event 'OrderPlaced' is emitted more than once in the same clause.");
        expect(messages).toContain("Read source 'OrderRepository' is listed more than once.");
        expect(messages).toContain("Journey actor 'Customer' has more than one block in this journey.");
    });

    test('authorizes same-document integration-event consumption through a local context map', async () => {
        const document = await parse(`
            bounded context Ordering
            bounded context Shipping
            in bounded context Ordering {
                module Contracts {
                    exposes OrderPlacedV1
                    integration event OrderPlacedV1 { orderId: string }
                }
            }
            in bounded context Shipping {
                application service Handler {
                    method onOrderPlaced(source: Ordering.Contracts.OrderPlacedV1)
                }
            }
            context map Fulfillment {
                customer Shipping -> supplier Ordering
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('allows a module to expose direct nested modules but not itself', async () => {
        const valid = await parse(`
            bounded context Alpha
            in bounded context Alpha {
                module Outer {
                    exposes Inner
                    module Inner {
                        value object Value { raw: string }
                    }
                }
            }
        `);
        expect(semanticDiagnostics(valid).filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Error)).toEqual([]);

        const invalid = await parse(`
            bounded context Beta
            in bounded context Beta {
                module M {
                    exposes M
                }
            }
        `);
        expect(semanticDiagnostics(invalid).some(diagnostic =>
            diagnostic.message === 'A module may expose only declarations that it owns.'
        )).toBe(true);
    });

    test('requires shared-kernel modules to expose specification and invocation targets', async () => {
        const document = await parse(`
            shared kernel Common {
                module Private {
                    value object Code { raw: string }
                    domain service PricingPolicy {
                        method normalize(amount: decimal) returns decimal
                    }
                }
            }
            bounded context Ordering
            bounded context Shipping
            context map SharedTypes {
                sharedKernel Common { participants: [Ordering, Shipping] }
            }
            in bounded context Ordering {
                application service App {
                    method run() {
                        behavior "Use [[Common.Private.Code]]."
                        invokes Common.Private.PricingPolicy.normalize
                    }
                }
            }
        `);
        const messages = semanticDiagnostics(document)
            .filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Error)
            .map(diagnostic => diagnostic.message);
        expect(messages).toContain('Using a module declaration from a shared kernel requires the module to expose that declaration.');
        expect(messages).toContain('A method may invoke across bounded-context boundaries only through an authorized shared-kernel domain service.');
    });

    test('warns when a journey invokes the same command more than once', async () => {
        const document = await parse(`
            bounded context Alpha
            in bounded context Alpha {
                application service App {
                    method run()
                }
            }
            actor Customer
            journey Run {
                by Customer {
                    invoke Alpha.App.run
                    invoke Alpha.App.run
                }
            }
        `);
        const warnings = semanticDiagnostics(document)
            .filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Warning)
            .map(diagnostic => diagnostic.message);
        expect(warnings).toContain("Command 'run' is invoked more than once in this journey; references resolve to the nearest prior invocation.");
    });

    test('allows modules to expose owned aggregate members and methods', async () => {
        const document = await parse(`
            bounded context Alpha
            in bounded context Alpha {
                module Api {
                    exposes Order.Order, Order.Order.place
                    aggregate Order {
                        root entity Order {
                            method place()
                            identifier id: OrderId
                        }
                        value object OrderId {
                            raw: string
                        }
                    }
                }
                module Consumer {
    depends on Api

                    domain service Inspector {
                        method inspect(order: Order.Order)
                    }
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic =>
            diagnostic.severity === DiagnosticSeverity.Error
        )).toEqual([]);
    });

    test('warns when an exposed command publishes private contract types', async () => {
        const document = await parse(`
            bounded context Alpha
            in bounded context Alpha {
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId
                    }
                    value object OrderId {
                        raw: string
                    }
                }
                module Api {
                    exposes run
                    application service Commands {
                        method run(id: OrderId)
                    }
                }
            }
        `);
        const warnings = semanticDiagnostics(document)
            .filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Warning)
            .map(diagnostic => diagnostic.message);
        expect(warnings.some(message => String(message).includes("Exposed command 'run' publishes private contract type"))).toBe(true);
    });

    test('does not warn when an exposed command uses an exposed aggregate-owned contract type', async () => {
        const document = await parse(`
            bounded context Shipping
            in bounded context Shipping {
                module Shipments {
                    aggregate ShipmentAggregate {
                        value object ShipmentId {
                            raw: string
                        }
                        root entity Shipment {
                            identifier id: ShipmentId
                        }
                    }
                    application service ShipmentApplication {
                        method dispatchShipment(id: ShipmentAggregate.ShipmentId)
                    }
                    exposes ShipmentAggregate, ShipmentAggregate.ShipmentId, ShipmentApplication
                }
            }
        `);
        const warnings = semanticDiagnostics(document)
            .filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Warning)
            .map(diagnostic => String(diagnostic.message));
        expect(warnings.some(message => message.includes("Exposed command 'dispatchShipment' publishes private contract type"))).toBe(false);
    });

    test('requires shared-kernel modules to expose declarations used by other contexts', async () => {
        const document = await parse(`
            shared kernel Common {
                module Private {
                    value object Code { raw: string }
                }
            }
            bounded context Ordering
            bounded context Shipping
            context map SharedTypes {
                sharedKernel Common { participants: [Ordering, Shipping] }
            }
            in bounded context Ordering {
                value object UsesCode { code: Common.Private.Code }
            }
        `);

        expect(semanticDiagnostics(document).some(diagnostic =>
            diagnostic.message === 'Using a module declaration from a shared kernel requires the module to expose that declaration.'
        )).toBe(true);
    });

    test('requires a shared-kernel relationship for shared declarations in specification text', async () => {
        const document = await parse(`
            shared kernel Common {
                value object Currency { code: string }
            }
            bounded context Ordering
            in bounded context Ordering {
                application service App {
                    method run() {
                        behavior "Use [[Common.Currency]]."
                    }
                }
            }
        `);

        expect(semanticDiagnostics(document).some(diagnostic =>
            diagnostic.message === 'Using a shared-kernel declaration in specification text requires an authorized context-map relationship from an imported map or a map declared in the same document as both endpoints.'
        )).toBe(true);
    });

    test('allows journey prose to link cross-context read and query values', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                read model OrderSummary { orderId: string }
                data object Eligibility { eligible: boolean }
                query service OrderQueries {
                    method canPlaceOrder() returns Eligibility
                }
                application service OrderCommands {
                    method placeOrder() {
                        behavior "Place the order."
                    }
                }
            }
            actor Customer
            journey PlaceOrder {
                by Customer {
                    invoke Ordering.OrderCommands.placeOrder
                        with "orderId from [[Ordering.OrderSummary.orderId]]"
                        when "The result [[Ordering.OrderQueries.canPlaceOrder.result.eligible]] allows it."
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('rejects private aggregate and domain-event internals in journey prose', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place()
                        identifier id: OrderId
                        secret: string
                    }
                    value object OrderId { raw: string }
                }
                event OrderPlaced { note: string }
                application service OrderCommands {
                    method placeOrder()
                }
            }
            actor Customer
            journey PlaceOrder {
                by Customer {
                    invoke Ordering.OrderCommands.placeOrder
                        when "Private [[Ordering.Order.Order.secret]] and [[Ordering.OrderPlaced.note]]."
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic =>
            diagnostic.message === 'Journey specifications may reference current inputs, prior command results, visible read/query values, and public contracts, but not private aggregate internals, later command operations, private command contract inputs or results, or private domain events.'
        )).toHaveLength(2);
    });

    test('allows journey contract closure across command timeline steps', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId
                    }
                    value object OrderId {
                        raw: string
                    }
                    enum OrderStatus {
                        Draft,
                        Placed
                    }
                }
                data object PlaceOrderInput {
                    orderId: OrderId
                }
                data object PlaceOrderResult {
                    orderId: OrderId
                    status: OrderStatus
                }
                data object PayResult {
                    paid: boolean
                }
                application service OrderApplication {
                    method placeOrder(input: PlaceOrderInput) returns PlaceOrderResult
                    method pay(orderId: OrderId) returns PayResult
                }
            }
            actor Customer
            journey PlaceOrder {
                by Customer {
                    invoke Ordering.OrderApplication.placeOrder
                        with "Current input [[Ordering.PlaceOrderInput.orderId]] and [[Ordering.Order.OrderId.raw]]"
                    invoke Ordering.OrderApplication.pay
                        with "Previous result [[Ordering.OrderApplication.placeOrder.result.orderId]]"
                        when "Previous input [[Ordering.OrderApplication.placeOrder.input.orderId]] and previous status [[Ordering.OrderApplication.placeOrder.result.status]] and [[Ordering.Order.OrderStatus.Placed]]"
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Error)).toEqual([]);
    });

    test('allows module-nested command contract types in journey prose', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId
                    }
                    value object OrderId {
                        raw: string
                    }
                }
                module Api {
                    data object RunInput {
                        orderId: OrderId
                    }
                    data object RunResult {
                        accepted: boolean
                    }
                    application service App {
                        method run(input: RunInput) returns RunResult
                    }
                }
            }
            actor Customer
            journey Run {
                by Customer {
                    invoke Ordering.Api.App.run
                        with "Input [[Ordering.Api.RunInput.orderId]] and identity [[Ordering.Order.OrderId.raw]]"
                }
            }
        `);
        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Error)).toEqual([]);
    });

    test('rejects private future command contract references in journey prose', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                data object FirstResult {
                    first: string
                }
                data object PublicInput {
                    payload: string
                }
                module Contracts {
                    data object SecondResult {
                        second: string
                    }
                    data object SecondInput {
                        input: string
                    }
                    application service App {
                        method first() returns FirstResult
                        method second(input: SecondInput) returns SecondResult
                    }
                }
            }
            actor Customer
            journey Ordered {
                by Customer {
                    invoke Ordering.Contracts.App.first
                        when "A future result [[Ordering.Contracts.SecondResult.second]], future input [[Ordering.Contracts.SecondInput.input]], and public input [[Ordering.PublicInput.payload]]"
                    invoke Ordering.Contracts.App.second
                }
            }
        `);
        const messages = semanticDiagnostics(document)
            .filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Error)
            .map(diagnostic => diagnostic.message);
        expect(messages.some(message => String(message).includes('later command operations, private command contract inputs or results'))).toBe(true);
    });

    test('allows public types used by future commands in journey prose', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                data object PublicInput {
                    payload: string
                }
                application service App {
                    method first()
                    method second(input: PublicInput)
                }
            }
            actor Customer
            journey Ordered {
                by Customer {
                    invoke Ordering.App.first
                        when "Public [[Ordering.PublicInput.payload]]"
                    invoke Ordering.App.second
                }
            }
        `);
        expect(semanticDiagnostics(document).filter(diagnostic =>
            diagnostic.severity === DiagnosticSeverity.Error
        )).toEqual([]);
    });

    test('rejects private module data shapes as non-terminal specification path segments', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                module Hidden {
                    value object Secret {
                        raw: string
                    }
                }
                application service App {
                    method run() {
                        behavior "Use [[Hidden.Secret.raw]] and [[Hidden.Secret]]."
                    }
                }
            }
        `);

        const messages = semanticDiagnostics(document).map(diagnostic => diagnostic.message);
        expect(messages).toContain('This specification path segment is not visible; use a context-visible or module-exposed declaration, or an authorized contract path.');
    });

    test('accepts same-module and exposed module data shapes as specification path segments', async () => {
        const sameModule = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                module Internal {
                    exposes Secret
                    value object Secret {
                        raw: string
                    }
                    application service App {
                        method run() {
                            behavior "Use [[Internal.Secret.raw]]."
                        }
                    }
                }
            }
        `);
        expect(semanticDiagnostics(sameModule).filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Error)).toEqual([]);

        const exposed = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                module Public {
                    exposes Secret
                    value object Secret {
                        raw: string
                    }
                }
                application service App {
                    method run() {
                        behavior "Use [[Public.Secret.raw]]."
                    }
                }
            }
        `);
        expect(semanticDiagnostics(exposed).filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Error)).toEqual([]);
    });

    test('rejects a private module shape used as a stepping stone to an exposed field', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                module Hidden {
                    exposes Inner
                    value object Secret {
                        inner: Inner
                    }
                    value object Inner {
                        raw: string
                    }
                }
                application service App {
                    method run() {
                        behavior "Use [[Hidden.Secret.inner.raw]]."
                    }
                }
            }
        `);

        expect(semanticDiagnostics(document).some(diagnostic =>
            diagnostic.message === 'This specification path segment is not visible; use a context-visible or module-exposed declaration, or an authorized contract path.'
        )).toBe(true);
    });

    test('underlines the invisible specification path segment, not the first segment', async () => {
        const source = `bounded context Ordering
in bounded context Ordering {
    module Hidden {
        value object Secret { raw: string }
    }
    application service App {
        method run() {
            behavior "Use [[Hidden.Secret.raw]]."
        }
    }
}`;
        const document = await parse(source);
        const diagnostic = semanticDiagnostics(document).find(candidate =>
            candidate.message === 'This specification path segment is not visible; use a context-visible or module-exposed declaration, or an authorized contract path.'
        );
        expect(diagnostic).toBeDefined();
        expect(document.textDocument.getText(diagnostic!.range)).toBe('Secret');
    });

    test('applies shared-kernel module visibility to data-bearing path segments', async () => {
        const privateShape = await parse(`
            shared kernel Common {
                module Hidden {
                    value object Secret { raw: string }
                }
                domain service Policy {
                    method run() {
                        behavior "Use [[Hidden.Secret.raw]]."
                    }
                }
            }
        `);
        expect(semanticDiagnostics(privateShape).some(diagnostic =>
            diagnostic.message === 'This specification path segment is not visible; use a context-visible or module-exposed declaration, or an authorized contract path.'
        )).toBe(true);

        const exposedShape = await parse(`
            shared kernel Common {
                module Hidden {
                    exposes Secret
                    value object Secret { raw: string }
                }
                domain service Policy {
                    method run() {
                        behavior "Use [[Hidden.Secret.raw]]."
                    }
                }
            }
        `);
        expect(semanticDiagnostics(exposedShape).filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('rejects current and unrelated aggregate contract references in journey prose', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId
                        secret: string
                    }
                    value object OrderId {
                        raw: string
                    }
                }
                data object PlaceOrderResult {
                    status: string
                }
                application service OrderApplication {
                    method placeOrder() returns PlaceOrderResult
                }
            }
            actor Customer
            journey PlaceOrder {
                by Customer {
                    invoke Ordering.OrderApplication.placeOrder
                        when "The current result [[Ordering.PlaceOrderResult.status]] and private aggregate state [[Ordering.Order.Order.secret]]"
                }
            }
        `);

        const messages = semanticDiagnostics(document)
            .filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Error)
            .map(diagnostic => diagnostic.message);
        expect(messages).toContain('Journey specifications may reference current inputs, prior command results, visible read/query values, and public contracts, but not private aggregate internals, later command operations, private command contract inputs or results, or private domain events.');
    });

    test('rejects private current command result contract paths in journey prose', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                module Contracts {
                    data object PlaceResult {
                        status: string
                    }
                    application service App {
                        method place() returns PlaceResult
                    }
                }
            }
            actor Customer
            journey Place {
                by Customer {
                    invoke Ordering.Contracts.App.place
                        when "The private current result [[Ordering.Contracts.PlaceResult.status]]"
                }
            }
        `);
        expect(semanticDiagnostics(document).some(diagnostic =>
            String(diagnostic.message).includes('later command operations, private command contract inputs or results')
        )).toBe(true);
    });

    test('rejects private services and modules in cross-context specification text', async () => {
        const document = await parse(`
            bounded context Ordering
            bounded context Shipping
            in bounded context Ordering {
                domain service PrivatePricing { method calculate() returns decimal }
                application service PrivateCommands { method run() }
                module PrivateModule { value object Code { raw: string } }
            }
            in bounded context Shipping {
                application service Shipment {
                    method ship() {
                        behavior "Use [[Ordering.PrivatePricing]], [[Ordering.PrivateCommands]], and [[Ordering.PrivateModule]]."
                    }
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic =>
            diagnostic.message === 'Specification text can reference another bounded context only through an authorized event or query contract.'
        ).length).toBeGreaterThanOrEqual(3);
    });

    test('does not validate an unfinished transition at the parent closing brace', async () => {
        const document = await parse(`
            bounded context Ordering in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place() {
                            transition status from
                        }
                        identifier id: OrderId
                        status: OrderStatus
                    }
                    value object OrderId { raw: string }
                    enum OrderStatus { Draft, Placed }
                }
            }
        `);

        expect(document.parseResult.parserErrors.length).toBeGreaterThan(0);
        expect(semanticDiagnostics(document).filter(diagnostic =>
            diagnostic.message === 'Transition states must be values of OrderStatus.'
        )).toEqual([]);
    });

    test('validates named types inside nested collection levels', async () => {
        const document = await parse(`
            bounded context A
            in bounded context A {
                aggregate Outer {
                    root entity Root {
                        identifier id: Id
                    }
                    value object Id {
                        raw: string
                    }
                    value object Secret {
                        text: string
                    }
                }
            }
            bounded context B
            in bounded context B {
                data object UsesSecrets {
                    direct: A.Outer.Secret
                    nestedList: List<List<A.Outer.Secret>>
                    nestedMap: Map<string, List<A.Outer.Secret>>
                }
                data object UsesEntities {
                    direct: A.Outer.Root
                    nested: List<Map<string, A.Outer.Root>>
                }
                application service App {
                    method use(items: List<Map<string, A.Outer.Root>>)
                }
            }
        `);

        const messages = semanticDiagnostics(document).map(diagnostic => diagnostic.message);
        expect(messages.filter(message =>
            message === 'A bounded context cannot directly use a value object from another bounded context as a field, parameter, or return type; use a local mirror, an IntegrationEvent, or a published query result contract.'
        )).toHaveLength(3);
        expect(messages.filter(message =>
            message === 'Data objects may contain value data, but not entities or read models.'
        )).toHaveLength(2);
        expect(messages.filter(message =>
            message === 'Application-service signatures must use identifiers or data values, not entity instances.'
        )).toHaveLength(1);
    });

    test('allows a published query result from an exposed sibling module', async () => {
        const document = await parse(`
            bounded context Api
            bounded context Consumer
            in bounded context Api {
                module Contracts {
                    exposes Result
                    data object Result {
                        text: string
                    }
                }
                module Services {
    depends on Contracts

                    exposes Queries
                    query service Queries {
                        method find() returns Result
                    }
                }
            }
            in bounded context Consumer {
                application service App {
                    method use() {
                        reads from Api.Services.Queries.find
                        behavior "Use [[Api.Contracts.Result.text]]."
                    }
                }
            }
            context map M {
                customer Consumer -> supplier Api
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('allows event handlers to link nested integration-event payload fields', async () => {
        const document = await parse(`
            bounded context Api
            bounded context Consumer
            in bounded context Api {
                module Contracts {
                    exposes E, Address
                    value object Address {
                        city: string
                    }
                    integration event E {
                        address: Address
                    }
                }
            }
            in bounded context Consumer {
                application service App {
                    method handle(source: Api.Contracts.E) {
                        behavior "Use [[source.address.city]]."
                        behavior "Use canonical [[Api.Contracts.E.address.city]]."
                    }
                }
            }
            context map M {
                customer Consumer -> supplier Api
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('requires bodyless projector methods to declare a target and event', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                projector Projection {
                    method project()
                }
            }
        `);

        const messages = semanticDiagnostics(document).map(diagnostic => diagnostic.message);
        expect(messages).toContain('A projector method must declare at least one read model with projects.');
        expect(messages).toContain('A projector method must handle exactly one domain or integration event.');
    });

    test('prevents value-object behavior from invoking aggregate-root behavior', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method place()
                        identifier id: OrderId
                    }
                    value object OrderId {
                        method normalize() {
                            invokes Order.Order.place
                        }
                        raw: string
                    }
                }
            }
        `);

        expect(semanticDiagnostics(document).map(diagnostic => diagnostic.message)).toContain(
            'Only entity behavior or an application service may invoke aggregate-root behavior.'
        );
    });

    test('does not throw while repository declarations are incomplete', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                repository ExistingRepository { manages Order.Order }
                repository IncompleteRepository
            }
        `);

        expect(exceptionDiagnostics(document)).toEqual([]);
    });

    test('does not throw while a referenced query repository has no read model', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                read model Summary { id: OrderId }
                event OrderPlaced
                query repository SummaryQueries reads from Order
                projector SummaryProjector {
                    method onOrderPlaced(source: OrderPlaced) {
                        projects Summary
                        behavior "Read [[SummaryQueries]]."
                    }
                }
            }
        `);

        expect(exceptionDiagnostics(document)).toEqual([]);
    });

    test('links quoted identifiers in declarations and references', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                data object D {
                    \`value\`: string
                }
                application service S {
                    method run(input: D) {
                        behavior "Use [[D.\`value\`]] and [[input.\`value\`]]."
                    }
                }
            }
        `);

        expect(document.parseResult.parserErrors).toEqual([]);
        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('requires backticks for reserved-word specification references', async () => {
        const unquoted = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                data object D {
                    \`value\`: string
                }
                application service S {
                    method run(input: D) {
                        behavior "Use [[D.value]] and [[input.value]]."
                    }
                }
            }
        `);

        const reservedMessages = semanticDiagnostics(unquoted)
            .map(diagnostic => String(diagnostic.message))
            .filter(message => message.includes("Reserved word 'value' must be backtick-quoted"));
        expect(reservedMessages).toHaveLength(2);

        const quoted = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                data object D {
                    \`value\`: string
                }
                application service S {
                    method run(input: D) {
                        behavior "Use [[D.\`value\`]] and [[input.\`value\`]]."
                    }
                }
            }
        `);
        expect(semanticDiagnostics(quoted)
            .map(diagnostic => String(diagnostic.message))
            .filter(message => message.includes('must be backtick-quoted'))).toEqual([]);
    });

    test('accepts integer and decimal primitives in every type position', async () => {
        const document = await parse(`
            bounded context Measurements
            in bounded context Measurements {
                value object Money {
                    constructor(amount: decimal, quantities: List<integer>) {
                        invariant "The amount is not negative."
                    }
                    method convert(rate: decimal) returns decimal {
                        behavior "Convert [[amount]] at [[rate]]."
                    }
                    method history() returns Map<string, List<Set<decimal>>> {
                        behavior "Return the decimal history."
                    }
                    amount: decimal
                    quantities: Map<string, List<integer>>
                }
            }
        `);

        expect(document.parseResult.parserErrors).toEqual([]);
        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('treats integer and decimal as reserved primitive keywords', async () => {
        const unquoted = await parse(`
            bounded context Types
            in bounded context Types {
                value object V {
                    \`decimal\`: decimal
                    \`integer\`: integer
                }
                application service S {
                    method run(input: V) {
                        behavior "Use [[V.decimal]] and [[V.integer]]."
                    }
                }
            }
        `);

        const reservedMessages = semanticDiagnostics(unquoted)
            .map(diagnostic => String(diagnostic.message))
            .filter(message => message.includes('must be backtick-quoted'));
        expect(reservedMessages).toHaveLength(2);
        expect(reservedMessages.some(message => message.includes("'decimal'"))).toBe(true);
        expect(reservedMessages.some(message => message.includes("'integer'"))).toBe(true);

        const quoted = await parse(`
            bounded context Types
            in bounded context Types {
                value object V {
                    \`decimal\`: decimal
                    \`integer\`: integer
                }
                application service S {
                    method run(input: V) {
                        behavior "Use [[V.\`decimal\`]] and [[V.\`integer\`]]."
                    }
                }
            }
        `);
        expect(semanticDiagnostics(quoted)
            .map(diagnostic => String(diagnostic.message))
            .filter(message => message.includes('must be backtick-quoted'))).toEqual([]);
    });

    test('allows exposed nested declarations through structural paths', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                module Api {
                    exposes Agg.Value
                    aggregate Agg {
                        root entity Root { identifier id: RootId }
                        value object RootId { raw: string }
                        value object Value { raw: string }
                    }
                }
                module Consumer {
    depends on Api

                    data object D { item: Agg.Value }
                    application service S {
                        method run() {
                            behavior "Use [[Agg.Value.raw]]."
                        }
                    }
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('allows invocation through a method exposed from a sibling module', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                module Api {
                    exposes Command.run
                    application service Command {
                        method run() {}
                    }
                }
                module Consumer {
    depends on Api

                    event Trigger
                    application service App {
                        method onTrigger(source: Trigger) {
                            invokes Api.Command.run
                        }
                    }
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('allows integration-event payload types from an exposed sibling module', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                module Types {
                    exposes Payload
                    value object Payload { raw: string }
                }
                module Contracts {
    depends on Types

                    exposes OrderPlacedV1
                    integration event OrderPlacedV1 { payload: Payload }
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('allows published query result value-object and enum references', async () => {
        const document = await parse(`
            bounded context Api
            bounded context Consumer
            in bounded context Api {
                module Contracts {
                    exposes Status, Address, Result
                    enum Status { Ready, Done }
                    value object Address { city: string }
                    data object Result { status: Status address: Address }
                }
                module Services {
    depends on Contracts

                    exposes Queries
                    query service Queries { method find() returns Result }
                }
            }
            in bounded context Consumer {
                application service App {
                    method use() {
                        reads from Api.Services.Queries.find
                        behavior "Use [[Api.Contracts.Result.address]], [[Api.Contracts.Address]], [[Api.Contracts.Result.status]], and [[Api.Contracts.Status.Ready]]."
                    }
                }
            }
            context map M {
                customer Consumer -> supplier Api
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('warns when a published query exposes aggregate-owned contract types', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                module Api {
                    exposes Queries, Result
                    data object Result { id: OrderId }
                    query service Queries {
                        method find() returns Result
                    }
                }
            }
        `);

        expect(semanticDiagnostics(document).some(diagnostic =>
            diagnostic.code === 'exposed-query-aggregate-contract'
        )).toBe(true);
    });

    test('rejects entity instances in factory and context-level value-object signatures', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    entity Line { identifier lineId: LineId }
                    value object OrderId { raw: string }
                    value object LineId { raw: string }
                }
                factory OrderFactory {
                    method create(line: Order.Line) returns Order.Order
                }
                value object Snapshot {
                    raw: string
                    constructor(line: Order.Line)
                    method inspect(line: Order.Line) returns Order.Line
                }
            }
        `);

        const messages = semanticDiagnostics(document).map(diagnostic => diagnostic.message);
        expect(messages).toContain('Factory method signatures must use identifiers or domain values, not entity instances.');
        expect(messages).toContain('Value-object signatures must use identifiers or domain values, not entity instances.');
        expect(messages).toContain('A constructor must reference another aggregate through its identifier, not its entity.');
    });

    test('rejects DataObjects in factory, context value-object, and domain-service signatures', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                data object Payload { raw: string }
                factory OrderFactory {
                    method create(input: Payload) returns Order.Order
                }
                value object Snapshot {
                    raw: string
                    method inspect(input: Payload) returns Payload
                }
                domain service Pricing {
                    method quote(input: Payload) returns Payload
                }
            }
        `);

        const messages = semanticDiagnostics(document).map(diagnostic => diagnostic.message);
        expect(messages).toContain('Factory method signatures must use identifiers or domain values, not DataObjects.');
        expect(messages.filter(message =>
            message === 'Value-object signatures must use domain values, not DataObjects.'
        )).toHaveLength(2);
        expect(messages).toContain('Domain-service methods must accept domain values or entity/aggregate parameters, not DataObjects.');
        expect(messages).toContain('Domain-service methods must return domain values, not DataObjects.');
    });

    test('rejects DataObjects in entity and aggregate-owned value-object methods', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        method useEntity(input: Payload) returns Payload
                        identifier id: OrderId
                    }
                    value object OrderId { raw: string }
                    value object Inline {
                        raw: string
                        method useValue(input: Payload) returns Payload
                    }
                }
                data object Payload { raw: string }
            }
        `);

        const messages = semanticDiagnostics(document).map(diagnostic => diagnostic.message);
        expect(messages.filter(message =>
            message === 'Entity method signatures must use domain values, not DataObjects.'
        )).toHaveLength(2);
        expect(messages.filter(message =>
            message === 'Value-object signatures must use domain values, not DataObjects.'
        )).toHaveLength(2);
    });

    test('allows DataObjects at application boundaries and domain values in factory and domain-service signatures', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                data object PlaceOrderInput { orderId: OrderId }
                value object OrderDraft { orderId: OrderId }
                factory OrderFactory {
                    method create(draft: OrderDraft) returns Order.Order
                }
                application service App {
                    method place(input: PlaceOrderInput) {
                        invokes OrderFactory.create
                    }
                }
                value object Snapshot {
                    raw: string
                    constructor(id: OrderId)
                    method inspect(id: OrderId) returns string
                }
                domain service Pricing {
                    method inspect(order: Order.Order) returns OrderDraft
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('allows projector behavior to reference its aggregate-repository read source', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                repository OrderRepository { manages Order.Order }
                read model Summary { id: OrderId }
                event OrderPlaced
                projector SummaryProjector {
                    method onOrderPlaced(source: OrderPlaced) {
                        reads from OrderRepository
                        projects Summary
                        behavior "Read [[OrderRepository]] to summarize."
                    }
                }
            }
        `);

        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === 1)).toEqual([]);
    });

    test('reports one owner-level diagnostic for invalid event and object fields', async () => {
        const document = await parse(`
            bounded context Ordering
            in bounded context Ordering {
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId
                    }
                    value object OrderId {
                        raw: string
                    }
                }
                data object Payload {
                    item: Ordering.Order.Order
                }
                read model Summary {
                    item: Ordering.Order.Order
                }
                integration event Contract {
                    item: Ordering.Order.Order
                }
                integration event AggregateValue {
                    id: OrderId
                }
            }
        `);

        const messages = semanticDiagnostics(document).map(diagnostic => diagnostic.message);
        expect(messages.filter(message =>
            message === 'Data objects may contain value data, but not entities or read models.'
        )).toHaveLength(1);
        expect(messages.filter(message =>
            message === 'Read models must project data rather than reference entity instances.'
        )).toHaveLength(1);
        expect(messages.filter(message =>
            message === 'Event payloads must not expose entity instances; use stable value data instead.'
        )).toHaveLength(1);
        expect(messages.filter(message =>
            message === 'An integration-event payload must not expose types owned by an aggregate.'
        )).toHaveLength(1);
        expect(messages.filter(message =>
            message === 'An aggregate must reference another aggregate through its identifier, not its entity.'
        )).toHaveLength(0);
    });

    test('requires query-repository serves and reads clauses on separate lines', async () => {
        const compact = await parse(`bounded context Ordering in bounded context Ordering {
            aggregate Order { root entity Order { identifier id: OrderId } value object OrderId { raw: string } }
            read model Summary { status: string }
            query repository SummaryQueries { serves Summary reads from Order }
        }`);
        const source = compact.textDocument.getText();
        const readsOffset = source.indexOf('reads');
        expect((compact.diagnostics ?? []).some(diagnostic =>
            diagnostic.code === 'line-break-required' &&
            compact.textDocument.offsetAt(diagnostic.range.start) === readsOffset
        )).toBe(true);

        const multiline = await parse(`bounded context Ordering
in bounded context Ordering {
    aggregate Order {
        root entity Order {
            identifier id: OrderId
        }
        value object OrderId {
            raw: string
        }
    }
    read model Summary {
        status: string
    }
    query repository SummaryQueries {
        serves Summary
        reads from Order
    }
}`);
        expect((multiline.diagnostics ?? []).filter(diagnostic =>
            diagnostic.code === 'line-break-required'
        )).toEqual([]);
    });

    test('reports one read-source diagnostic per invalid source', async () => {
        const document = await parse(`bounded context Ordering in bounded context Ordering {
            read model Summary { status: string }
            query repository SummaryQueries { serves Summary }
            query repository OtherQueries { serves Summary }
            application service App {
                method run() { reads from SummaryQueries, OtherQueries }
            }
        }`);
        const errors = semanticDiagnostics(document).filter(diagnostic =>
            String(diagnostic.message) === 'An application-service method must use command-side repositories, not query repositories.'
        );
        expect(errors).toHaveLength(2);
        const source = document.textDocument.getText();
        const readsClauseStart = source.indexOf('reads from');
        expect(errors.map(diagnostic => document.textDocument.offsetAt(diagnostic.range.start))).toEqual([
            source.indexOf('SummaryQueries', readsClauseStart),
            source.indexOf('OtherQueries', readsClauseStart)
        ]);
    });

    test('rejects result parameter names that collide with operation result contracts', async () => {
        const source = `bounded context Ordering in bounded context Ordering {
            data object Input { raw: string }
            data object Output { raw: string }
            application service App {
                method command(result: Input) returns Output
                method fire(result: Input)
            }
            domain service Policy {
                method calculate(result: Input)
            }
        }`;
        const document = await parse(source);
        const reserved = semanticDiagnostics(document).filter(diagnostic =>
            diagnostic.code === 'reserved-result-name'
        );
        expect(reserved).toHaveLength(2);
        expect(reserved.map(diagnostic => document.textDocument.offsetAt(diagnostic.range.start))).toEqual([
            source.indexOf('result: Input'),
            source.indexOf('result: Input', source.indexOf('result: Input') + 1)
        ]);
    });

    test('rejects entities hidden inside value objects at entity and value-object boundaries', async () => {
        const document = await parse(`
            bounded context C
            in bounded context C {
                aggregate B {
                    root entity B {
                        identifier id: IdB
                    }
                    value object IdB {
                        raw: string
                    }
                    value object Snapshot {
                        member: B
                    }
                }
                aggregate A {
                    root entity A {
                        identifier id: IdA
                        snapshot: Snapshot
                        constructor(snapshot: Snapshot) {
                            invariant "The snapshot is required."
                        }
                        method inspect(snapshot: Snapshot) returns Snapshot {
                            behavior "Inspect the snapshot."
                        }
                    }
                    value object IdA {
                        raw: string
                    }
                }
            }
        `);
        const messages = semanticDiagnostics(document).map(diagnostic => diagnostic.message);
        expect(messages.filter(message =>
            message === 'An aggregate must reference another aggregate through its identifier, not an entity nested in a value object.'
        )).toHaveLength(1);
        expect(messages.filter(message =>
            message === 'Reference another aggregate by its identifier, not by passing its entity instance.'
        )).toHaveLength(2);
        expect(messages.filter(message =>
            message === 'A constructor must reference another aggregate through its identifier, not an entity nested in a value object.'
        )).toHaveLength(1);
    });

    test('allows same-aggregate entities nested in aggregate-owned value objects', async () => {
        const document = await parse(`
            bounded context C
            in bounded context C {
                aggregate A {
                    root entity A {
                        identifier id: IdA
                        snapshot: Snapshot
                    }
                    value object IdA {
                        raw: string
                    }
                    value object Snapshot {
                        member: A
                    }
                }
            }
        `);
        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Error)).toEqual([]);
    });

    test('rejects entities hidden inside value objects returned by domain services', async () => {
        const document = await parse(`
            bounded context C
            in bounded context C {
                aggregate A {
                    root entity A {
                        identifier id: IdA
                    }
                    value object IdA {
                        raw: string
                    }
                    value object Snapshot {
                        member: A
                    }
                }
                domain service Inspector {
                    method inspect() returns Snapshot
                }
            }
        `);
        expect(semanticDiagnostics(document).some(diagnostic =>
            diagnostic.message === 'Domain-service methods must return domain values, not aggregate entities.'
        )).toBe(true);
    });

    test('rejects application-service invocation of context-level value-object methods', async () => {
        const document = await parse(`
            bounded context C
            in bounded context C {
                value object Money {
                    amount: decimal
                    method plus(other: Money) returns Money
                }
                application service App {
                    method run(money: Money) returns Money {
                        invokes Money.plus
                    }
                }
            }
        `);
        expect(semanticDiagnostics(document).some(diagnostic =>
            diagnostic.message === 'An application service may not invoke a value-object method directly; invoke aggregate-root, factory, or domain-service behavior.'
        )).toBe(true);
    });

    test('allows module-exposed query services to publish context-level DataObjects', async () => {
        const document = await parse(`
            bounded context Api
            bounded context Consumer
            in bounded context Api {
                data object Result {
                    amount: string
                }
                module Services {
                    exposes Queries
                    query service Queries {
                        method find() returns Result
                    }
                }
            }
            in bounded context Consumer {
                application service App {
                    method use() {
                        reads from Api.Services.Queries.find
                        behavior "Use [[Api.Result.amount]]."
                    }
                }
            }
            context map M {
                customer Consumer -> supplier Api
            }
        `);
        expect(semanticDiagnostics(document).filter(diagnostic => diagnostic.severity === DiagnosticSeverity.Error)).toEqual([]);
    });

    test('rejects qualified context, subdomain, and shared-kernel paths', async () => {
        const document = await parse(`
            subdomain Marketing
            shared kernel Common {
                value object V { raw: string }
            }

            bounded context Ordering
            bounded context Shipping

            bounded context Billing realizes Ordering.Marketing

            in bounded context Ordering.Shipping {
                event OrderPlaced
            }

            context map Paths {
                customer Ordering.Shipping -> supplier Shipping
                separateWays Ordering.Shipping -x- Shipping
                sharedKernel Ordering.Common {
                    participants: [Ordering.Shipping, Shipping]
                }
            }
        `);
        const messages = semanticDiagnostics(document).map(diagnostic => String(diagnostic.message));
        expect(messages.filter(message => message.includes('bounded contexts are top-level declarations'))).toHaveLength(1);
        expect(messages.filter(message => message.includes('subdomains are top-level declarations'))).toHaveLength(1);
        expect(messages.filter(message => message.includes('endpoints cannot qualify')).length).toBeGreaterThanOrEqual(4);
    });

    test('requires every enclosing module to expose nested declarations', async () => {
        const hidden = await parse(`
            bounded context C
            in bounded context C {
                module Outer {
                    module Inner {
                        exposes V
                        value object V { raw: string }
                    }
                }
                data object D {
                    payload: C.Outer.Inner.V
                }
            }
        `);
        expect(semanticDiagnostics(hidden).some(diagnostic =>
            String(diagnostic.message).includes('and all enclosing modules expose it')
        )).toBe(true);

        const exposed = await parse(`
            bounded context C2
            in bounded context C2 {
                module Outer {
                    exposes Inner
                    module Inner {
                        exposes V
                        value object V { raw: string }
                    }
                }
                data object D {
                    payload: C2.Outer.Inner.V
                }
            }
        `);
        expect(semanticDiagnostics(exposed).filter(diagnostic =>
            diagnostic.severity === DiagnosticSeverity.Error
        )).toEqual([]);
    });

    test('requires the complete module chain to expose a cross-context integration event', async () => {
        const hidden = await parse(`
            bounded context P
            in bounded context P {
                module Outer {
                    module Inner {
                        exposes E
                        integration event E { x: string }
                    }
                }
            }
            bounded context C
            in bounded context C {
                application service App {
                    method onE(source: P.Outer.Inner.E)
                }
            }
            context map M {
                customer C -> supplier P
            }
        `);
        expect(semanticDiagnostics(hidden).some(diagnostic =>
            String(diagnostic.message).includes('every enclosing module')
        )).toBe(true);

        const exposed = await parse(`
            bounded context P2
            in bounded context P2 {
                module Outer {
                    exposes Inner
                    module Inner {
                        exposes E
                        integration event E { x: string }
                    }
                }
            }
            bounded context C2
            in bounded context C2 {
                application service App {
                    method onE(source: P2.Outer.Inner.E)
                }
            }
            context map M2 {
                customer C2 -> supplier P2
            }
        `);
        expect(semanticDiagnostics(exposed).filter(diagnostic =>
            diagnostic.severity === DiagnosticSeverity.Error
        )).toEqual([]);
    });

    test('allows command contract types in nested private modules in journey prose', async () => {
        const document = await parse(`
            bounded context C
            in bounded context C {
                module Outer {
                    module Inner {
                        data object RunInput { orderId: string }
                        data object RunResult { accepted: boolean }
                        application service App {
                            method run(input: RunInput) returns RunResult
                        }
                    }
                }
            }
            actor Customer
            journey J {
                by Customer {
                    invoke C.Outer.Inner.App.run
                        with "Input [[C.Outer.Inner.RunInput.orderId]]"
                }
            }
        `);
        expect(semanticDiagnostics(document).filter(diagnostic =>
            diagnostic.severity === DiagnosticSeverity.Error
        )).toEqual([]);
    });

    test('rejects private query operations as journey path segments', async () => {
        const document = await parse(`
            bounded context C
            in bounded context C {
                data object Result { status: string }
                module Internal {
                    query service Hidden {
                        method find() returns Result
                    }
                }
                application service App {
                    method run()
                }
            }
            actor Customer
            journey J {
                by Customer {
                    invoke C.App.run when "Use [[C.Internal.Hidden.find.result.status]]."
                }
            }
        `);
        expect(semanticDiagnostics(document).some(diagnostic =>
            String(diagnostic.message).includes('This specification path segment is not visible')
        )).toBe(true);
    });

    test('allows published aggregate-owned contract types through their canonical path', async () => {
        const document = await parse(`
            bounded context P
            in bounded context P {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
                data object OrderDto {
                    orderId: OrderId
                }
                module Api {
                    exposes Queries
                    query service Queries {
                        method find() returns OrderDto
                    }
                }
            }
            bounded context C
            in bounded context C {
                application service App {
                    method run() {
                        reads from P.Api.Queries.find
                        behavior "Use [[P.Order.OrderId.raw]] and [[P.OrderDto.orderId.raw]]."
                    }
                }
            }
            context map M {
                customer C -> supplier P
            }
        `);
        expect(semanticDiagnostics(document).filter(diagnostic =>
            diagnostic.severity === DiagnosticSeverity.Error
        )).toEqual([]);
    });

    test('allows published contract types through private nested module paths', async () => {
        const document = await parse(`
            bounded context P
            in bounded context P {
                module Outer {
                    module Inner {
                        exposes Result
                        data object Result { status: string }
                    }
                }
                module Api {
    depends on Inner

                    exposes Queries
                    query service Queries { method find() returns Outer.Inner.Result }
                }
            }
            bounded context C
            in bounded context C {
                application service App {
                    method use() {
                        reads from P.Api.Queries.find
                        behavior "Use [[P.Outer.Inner.Result.status]]."
                    }
                }
            }
            context map M { customer C -> supplier P }
        `);
        expect(semanticDiagnostics(document).filter(diagnostic =>
            diagnostic.severity === DiagnosticSeverity.Error
        )).toEqual([]);
    });

    test('resolves prior journey results under canonical, suffix, and alias spellings', async () => {
        const document = await parse(`
            bounded context C
            in bounded context C {
                data object Result { status: string }
                application service App {
                    method place() returns Result
                    method pay()
                }
            }
            actor Customer
            journey J {
                by Customer {
                    invoke App.place
                    invoke C.App.pay when "[[C.App.place.result.status]] and [[App.place.result.status]]"
                }
            }
        `);
        expect(semanticDiagnostics(document).filter(diagnostic =>
            diagnostic.severity === DiagnosticSeverity.Error
        )).toEqual([]);
    });

    test('allows result as an event-handler parameter when the handler has no result', async () => {
        const document = await parse(`
            bounded context C
            in bounded context C {
                event E
                data object R { amount: string }
                application service App {
                    method onE(result: E)
                    method onEResult(result: E) returns R
                }
            }
        `);
        const reserved = semanticDiagnostics(document).filter(diagnostic =>
            diagnostic.code === 'reserved-result-name'
        );
        expect(reserved).toHaveLength(1);
        expect(document.textDocument.offsetAt(reserved[0]!.range.start)).toBe(
            document.textDocument.getText().indexOf('result: E', document.textDocument.getText().indexOf('result: E') + 1)
        );
    });

    test('limits bare field and method references to the enclosing entity or value object', async () => {
        const invalid = await parse(`
            bounded context C
            in bounded context C {
                application service App {
                    method run() { behavior "Use [[other]]." }
                    method other()
                }
            }
        `);
        expect(semanticDiagnostics(invalid).some(diagnostic =>
            String(diagnostic.message).includes('Bare field and method references are limited')
        )).toBe(true);

        const valid = await parse(`
            bounded context D
            in bounded context D {
                aggregate A {
                    root entity A {
                        method run() { behavior "Use [[helper]]." }
                        method helper()
                        identifier id: AId
                    }
                    value object AId { raw: string }
                }
            }
        `);
        expect(semanticDiagnostics(valid).filter(diagnostic =>
            diagnostic.severity === DiagnosticSeverity.Error
        )).toEqual([]);
    });

    test('requires the first segment of a multi-segment bare specification path to be owned', async () => {
        const invalid = await parse(`
            bounded context C
            in bounded context C {
                aggregate A {
                    root entity A {
                        method run() { behavior "Use [[bField.raw]]." }
                        identifier id: AId
                    }
                    value object AId { raw: string }
                }
                aggregate B {
                    root entity B {
                        identifier id: BId
                        bField: BV
                    }
                    value object BId { raw: string }
                    value object BV { raw: string }
                }
            }
        `);
        expect(semanticDiagnostics(invalid).some(diagnostic =>
            String(diagnostic.message).includes("Could not resolve reference to SpecificationTarget named 'bField'")
        )).toBe(true);

        const valid = await parse(`
            bounded context D
            in bounded context D {
                aggregate A {
                    root entity A {
                        method run() { behavior "Use [[address.street]]." }
                        identifier id: AId
                        address: Address
                    }
                    value object AId { raw: string }
                    value object Address { street: string }
                }
            }
        `);
        expect(semanticDiagnostics(valid).filter(diagnostic =>
            diagnostic.severity === DiagnosticSeverity.Error
        )).toEqual([]);
    });

    test('rejects entities nested in domain-service parameter shapes and collections', async () => {
        const document = await parse(`
            bounded context C
            in bounded context C {
                aggregate A {
                    root entity A { identifier id: Id }
                    value object Id { raw: string }
                    value object Holder { a: A }
                }
                domain service S {
                    method byValue(holder: Holder) { behavior "By value." }
                    method byCollection(items: List<A>) { behavior "By collection." }
                }
            }
        `);
        const messages = semanticDiagnostics(document).map(diagnostic => String(diagnostic.message));
        expect(messages).toContain('Domain-service methods must use domain values or direct entity parameters, not value objects containing entity instances.');
        expect(messages).toContain('Domain-service methods must use direct entity parameters, not collections of entities.');

        const valid = await parse(`
            bounded context D
            in bounded context D {
                aggregate A {
                    root entity A { identifier id: Id }
                    value object Id { raw: string }
                }
                domain service S {
                    method byDirect(a: A) { behavior "By direct entity." }
                }
            }
        `);
        expect(semanticDiagnostics(valid).filter(diagnostic =>
            diagnostic.severity === DiagnosticSeverity.Error
        )).toEqual([]);
    });

    test('rejects query operations in non-journey prose but allows their own result binding', async () => {
        const invalid = await parse(`
            bounded context C
            in bounded context C {
                query service Queries { method find() returns string }
                application service App {
                    method run() { behavior "Use [[C.Queries.find]]." }
                }
            }
        `);
        expect(semanticDiagnostics(invalid).some(diagnostic =>
            String(diagnostic.message).includes('Non-journey prose must link a query result type or field')
        )).toBe(true);

        const valid = await parse(`
            bounded context D
            in bounded context D {
                query service Queries {
                    method find() returns string {
                        behavior "Use [[result]]."
                    }
                }
            }
        `);
        expect(semanticDiagnostics(valid).filter(diagnostic =>
            diagnostic.severity === DiagnosticSeverity.Error
        )).toEqual([]);
    });

    test('rejects mirrored identifiers inside shared kernels', async () => {
        const document = await parse(`
            shared kernel Common {
                value object MirroredId mirrors Ordering.Order.OrderId {
                    raw: string
                }
            }
            bounded context Ordering
            in bounded context Ordering {
                aggregate Order {
                    root entity Order { identifier id: OrderId }
                    value object OrderId { raw: string }
                }
            }
        `);
        expect(semanticDiagnostics(document).some(diagnostic =>
            String(diagnostic.message).includes('A mirrored identifier must be declared in a bounded context, not a shared kernel.')
        )).toBe(true);
    });

    test('allows authorized integration-event payload shapes outside event handlers', async () => {
        const document = await parse(`
            bounded context P
            in bounded context P {
                value object OrderId { raw: string }
                integration event E {
                    orderId: OrderId
                    customerId: string
                }
            }
            bounded context C
            in bounded context C {
                application service App {
                    method use() {
                        behavior "Use [[P.E.customerId]] and [[P.E.orderId.raw]]."
                    }
                }
            }
            context map M {
                customer C -> supplier P
            }
        `);
        expect(semanticDiagnostics(document).filter(diagnostic =>
            diagnostic.severity === DiagnosticSeverity.Error
        )).toEqual([]);
    });

    test('rejects private entity fields used as non-terminal journey path segments', async () => {
        const document = await parse(`
            bounded context C
            in bounded context C {
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId
                        internal: Details
                    }
                    value object OrderId {
                        raw: string
                    }
                    value object Details {
                        publicField: string
                    }
                }
                application service App {
                    method run()
                }
            }
            actor Customer
            journey J {
                by Customer {
                    invoke C.App.run
                        when "[[C.Order.Order.internal.publicField]]"
                }
            }
        `);

        expect(semanticDiagnostics(document).some(diagnostic =>
            diagnostic.message === 'This specification path segment is not visible; use a context-visible or module-exposed declaration, or an authorized contract path.'
        )).toBe(true);
        expect(semanticDiagnostics(document).some(diagnostic =>
            diagnostic.message === 'Could not resolve reference to SpecificationTarget named \'publicField\'.'
        )).toBe(true);
    });

    test('does not count invalid repositories as duplicate write repositories', async () => {
        const document = await parse(`
            bounded context A
            in bounded context A {
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId
                    }
                    value object OrderId {
                        raw: string
                    }
                    value object Details {
                        note: string
                    }
                }
                repository Invalid {
                    manages Details
                }
                repository Valid {
                    manages Order
                }
            }
        `);

        const messages = semanticDiagnostics(document).map(diagnostic => String(diagnostic.message));
        expect(messages).toContain('A repository must manage an aggregate-root entity.');
        expect(messages.some(message => message.includes('multiple write repositories'))).toBe(false);
    });

    test('still rejects a second valid write repository for the same aggregate', async () => {
        const document = await parse(`
            bounded context A
            in bounded context A {
                aggregate Order {
                    root entity Order {
                        identifier id: OrderId
                    }
                    value object OrderId {
                        raw: string
                    }
                }
                repository First {
                    manages Order
                }
                repository Second {
                    manages Order
                }
            }
        `);

        expect(semanticDiagnostics(document).some(diagnostic =>
            String(diagnostic.message).includes("Aggregate 'Order' has multiple write repositories")
        )).toBe(true);
    });

    test('allows one exposes clause anywhere in a module, but not two', async () => {
        const valid = await parse(`bounded context Ordering
in bounded context Ordering {
    module Api {
        application service Service {
            method run() {
                behavior "Run."
            }
        }
        exposes Service
    }
}`);
        expect(valid.parseResult.parserErrors).toEqual([]);
        expect(semanticDiagnostics(valid).filter(diagnostic =>
            String(diagnostic.message).includes("exposes")
        )).toEqual([]);

        const duplicate = await parse(`bounded context Ordering
in bounded context Ordering {
    module Api {
        application service Service {
            method run() {
                behavior "Run."
            }
        }
        exposes Service
        exposes Service
    }
}`);
        expect(semanticDiagnostics(duplicate).some(diagnostic =>
            String(diagnostic.message).includes("A module may declare 'exposes' at most once.")
        )).toBe(true);
    });

    test('places module dependencies in the body and allows only one clause', async () => {
        const valid = await parse(`bounded context X
in bounded context X {
    module Domain {
        value object W { raw: string }
    }
    module Api {
        depends on Domain
        value object V { raw: string }
    }
}`);
        expect(valid.parseResult.parserErrors).toEqual([]);
        expect(semanticDiagnostics(valid).filter(diagnostic =>
            String(diagnostic.message).includes('depend')
        )).toEqual([]);

        const duplicate = await parse(`bounded context X
in bounded context X {
    module Domain {
        value object W { raw: string }
    }
    module Api {
        depends on Domain
        depends on Domain
        value object V { raw: string }
    }
}`);
        expect(semanticDiagnostics(duplicate).some(diagnostic =>
            String(diagnostic.message).includes("A module may declare 'depends on' at most once.")
        )).toBe(true);

        const header = await parse(`bounded context X
in bounded context X {
    module Api depends on Domain {}
    module Domain {
        value object W { raw: string }
    }
}`);
        expect(header.parseResult.parserErrors.length).toBeGreaterThan(0);
    });

});

function checkDocumentValid(document: LangiumDocument): string | undefined {
    return document.parseResult.parserErrors.length && `Parser errors: ${document.parseResult.parserErrors.map(error => error.message).join('; ')}`
        || document.parseResult.value === undefined && `ParseResult is 'undefined'.`
        || !isModel(document.parseResult.value) && `Root AST object is a ${document.parseResult.value.$type}, expected a 'Model'.`
        || undefined;
}

function diagnosticToString(diagnostic: Diagnostic): string {
    return `[${diagnostic.range.start.line}:${diagnostic.range.start.character}..${diagnostic.range.end.line}:${diagnostic.range.end.character}]: ${diagnostic.message}`;
}

function semanticDiagnostics(document: LangiumDocument): Diagnostic[] {
    // Most semantic-validation fixtures are compact; line-break policy has dedicated coverage.
    return (document.diagnostics ?? []).filter(diagnostic =>
        diagnostic.code !== 'line-break-required' && diagnostic.code !== 'line-break-required-after-open-brace'
    );
}

function exceptionDiagnostics(document: LangiumDocument): Diagnostic[] {
    return (document.diagnostics ?? []).filter(diagnostic =>
        String(diagnostic.message).startsWith('An error occurred')
    );
}
