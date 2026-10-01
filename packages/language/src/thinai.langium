grammar Thinai

entry Model:
    (imports+=Import | declarations+=TopLevelDeclaration)*;

TopLevelDeclaration:
    SharedKernel
    | Subdomain
    | BoundedContext
    | BoundedContextPart
    | ContextMap;

Import:
    'import' path=StringLiteral
    (('as' alias=ID) | '{' components+=ImportComponent (',' components+=ImportComponent)* '}')? ';'?;

ImportComponent:
    component=[ImportableComponent:QualifiedName] ('as' alias=ID)?;


BoundedContext:
    'bounded' 'context' name=ID
    ('realizes' subdomains+=[Subdomain:QualifiedName] (',' subdomains+=[Subdomain:QualifiedName])*)?
    '{'
        members+=ContextMember*
    '}' ';'?;

BoundedContextPart:
    'part' 'of' 'bounded' 'context' context=[BoundedContext:QualifiedName] '{'
        members+=ContextMember*
    '}' ';'?;

ContextMap:
    'context' 'map' name=ID '{'
        relationships+=ContextRelationship*
    '}' ';'?;

ContextRelationship:
    CustomerSupplierRelationship
    | PartnershipRelationship
    | SeparateWaysRelationship
    | SharedKernelRelationship;

CustomerSupplierRelationship:
    'customer' customer=ContextMapEndpoint '->' 'supplier' supplier=ContextMapEndpoint ';'?;

PartnershipRelationship:
    'partner' left=ContextMapEndpoint '<->' 'partner' right=ContextMapEndpoint ';'?;

SeparateWaysRelationship:
    'separateWays' left=[BoundedContext:QualifiedName] '-x-' right=[BoundedContext:QualifiedName] ';'?;

SharedKernelRelationship:
    'sharedKernel' sharedKernel=[SharedKernel:QualifiedName] '{'
        'participants' ':' '[' participants+=[BoundedContext:QualifiedName] (',' participants+=[BoundedContext:QualifiedName])* ']' ';'?
    '}' ';'?;

ContextMapEndpoint:
    context=[BoundedContext:QualifiedName]
    ('{' 'integrationPatterns' ':' '[' integrationPatterns+=StringLiteral (',' integrationPatterns+=StringLiteral)* ']' ';'? '}')?;

ApplicationService:
    'application' 'service' name=ID 'for' aggregate=[Aggregate:QualifiedName] '{'
        methods+=Method*
    '}' ';'?;

ContextMember:
    ApplicationService
    | Capability
    | Aggregate
    | DomainService
    | Repository
    | Factory
    | DomainEvent
    | IntegrationEvent
    | Flow
    | Module
    | TypeDeclaration;

SharedKernel:
    'shared' 'kernel' name=ID '{'
        members+=SharedKernelMember*
    '}' ';'?;

SharedKernelMember:
    ValueObject
    | EnumType
    | Module;

Module:
    'module' name=ID
    ('depends' 'on' dependencies+=[Module:QualifiedName] (',' dependencies+=[Module:QualifiedName])*)?
    '{'
        exposures+=Exposure*
        members+=ModuleMember*
    '}' ';'?;

Exposure:
    'exposes' declarations+=[NamedDeclaration:QualifiedName] (',' declarations+=[NamedDeclaration:QualifiedName])* ';'?;

ModuleMember:
    ApplicationService
    | Capability
    | Aggregate
    | DomainService
    | Repository
    | Factory
    | DomainEvent
    | IntegrationEvent
    | Flow
    | Module
    | TypeDeclaration;

Subdomain:
    'subdomain' name=ID ('kind' kind=SubdomainKind)? ';'?;

Capability:
    'capability' name=ID ';'?;

Aggregate:
    'aggregate' name=ID '{'
        (members+=AggregateMember | invariants+=Invariant | methods+=Method)*
    '}' ';'?;

AggregateMember:
    Entity
    | ValueObject
    | EnumType
    | DomainService
    | Repository
    | Factory;

Entity:
    (root?='root')? 'entity' name=ID ('extends' base=[Entity:QualifiedName])?
    '{' constructors+=Constructor* methods+=Method* fields+=Field* '}' ';'?;

ValueObject:
    'value' 'object' name=ID
    ('mirrors' mirrors=[ValueObject:QualifiedName])?
    '{' constructors+=Constructor* methods+=Method* fields+=Field* '}' ';'?;

EnumType:
    'enum' name=ID '{' values+=EnumValue (','? values+=EnumValue)* '}' ';'?;

EnumValue:
    name=ID;

Field:
    (identifier?='identifier')? name=ID (optional?='?')? ':' (primitive=PrimitiveType | type=[TypeDeclaration:QualifiedName] | collection=CollectionType) ';'?;

Invariant:
    'invariant' description=BehaviorSpecificationText ';'?;

Precondition:
    'precondition' description=BehaviorSpecificationText ';'?;

Postcondition:
    'postcondition' description=BehaviorSpecificationText ';'?;

Behavior:
    'behavior' description=BehaviorSpecificationText ';'?;

TypeDeclaration:
    Entity
    | ValueObject
    | EnumType;

DomainService:
    'domain' 'service' name=ID ('{' methods+=Method* '}')? ';'?;

Method:
    'method' name=ID '(' (parameters+=Parameter (',' parameters+=Parameter)*)? ')'
    ('returns' (returnPrimitive=PrimitiveType | returnType=[TypeDeclaration:QualifiedName] | returnCollection=CollectionType))?
    ('invokes' invocations+=[Method:QualifiedName] (',' invocations+=[Method:QualifiedName])*)?
    ('emits' events+=[EventDeclaration:QualifiedName] (',' events+=[EventDeclaration:QualifiedName])*)?
    ('{' (invariants+=Invariant | preconditions+=Precondition | postconditions+=Postcondition | behaviors+=Behavior | transitions+=Transition)* '}')? ';'?;

Transition:
    'transition' field=ID 'from' from=ID 'to' to=ID ';'?;

Constructor:
    'constructor' '(' (parameters+=Parameter (',' parameters+=Parameter)*)? ')'
    ('{' (invariants+=Invariant | preconditions+=Precondition | postconditions+=Postcondition | behaviors+=Behavior)* '}')? ';'?;

Parameter:
    name=ID (optional?='?')? ':' ('event' eventType=[EventDeclaration:QualifiedName] |
        primitive=PrimitiveType | type=[TypeDeclaration:QualifiedName] | collection=CollectionType);

Repository:
    'repository' name=ID 'for' aggregate=[Aggregate:QualifiedName] ';'?;

Factory:
    'factory' name=ID 'for' aggregate=[Aggregate:QualifiedName]
    ('operations' '{' methods+=Method* '}')? ';'?;

DomainEvent:
    'event' name=ID
    ('data' '{' fields+=Field* '}')?
    ';'?;

IntegrationEvent:
    'integration' 'event' name=ID
    ('data' '{' fields+=Field* '}')?
    ';'?;

type EventDeclaration = DomainEvent | IntegrationEvent;

type NamedDeclaration = Aggregate | ApplicationService | BoundedContext | Capability | DomainEvent | DomainService | Entity |
    EnumType | Factory | Flow | IntegrationEvent | Method | Module |
    Repository | Subdomain | ValueObject;

Flow:
    'flow' name=ID '{' elements+=FlowElement* '}' ';'?;

FlowElement:
    'actor' actor=ID ';'?
    | 'invoke' method=[Method:QualifiedName] ';'?;

type ImportableComponent = BoundedContext | ContextMap | SharedKernel;

CollectionType:
    kind=CollectionKind '<'
    (elementPrimitive=PrimitiveType | elementType=[TypeDeclaration:QualifiedName] | elementCollection=CollectionType)
    (',' (valuePrimitive=PrimitiveType | valueType=[TypeDeclaration:QualifiedName] | valueCollection=CollectionType))?
    '>';

CollectionKind returns string:
    'List' | 'Set' | 'Map';

BehaviorSpecificationText:
    DOUBLE_STRING_START (parts+=BehaviorSpecificationTextPart)* DOUBLE_STRING_END
    | SINGLE_STRING_START (parts+=BehaviorSpecificationTextPart)* SINGLE_STRING_END;

BehaviorSpecificationTextPart:
    text=DOUBLE_STRING_TEXT
    | text=SINGLE_STRING_TEXT
    | '[[' target=[BehaviorSpecificationTarget:QualifiedName] REFERENCE_END;

type BehaviorSpecificationTarget = Method | Field;

StringLiteral returns string:
    DOUBLE_STRING_START (DOUBLE_STRING_TEXT | '[[' QualifiedName REFERENCE_END)* DOUBLE_STRING_END
    | SINGLE_STRING_START (SINGLE_STRING_TEXT | '[[' QualifiedName REFERENCE_END)* SINGLE_STRING_END;

PrimitiveType returns string:
    'string' | 'number' | 'boolean' | 'date';

SubdomainKind returns string:
    'core' | 'supporting' | 'generic';

QualifiedName returns string:
    ID ('.' ID)*;

hidden terminal WS: /\s+/;
terminal ID: /[_a-zA-Z][\w_]*/;
terminal DOUBLE_STRING_START: /"/;
// The token builder remaps the sentinel-prefixed endings to quote tokens in string modes.
terminal DOUBLE_STRING_END: /\u0000"/;
terminal SINGLE_STRING_START: /'/;
terminal SINGLE_STRING_END: /\u0000'/;
terminal REFERENCE_END: /\]\]/;
terminal DOUBLE_STRING_TEXT: /(\\.|[^"\\\[]|\[(?!\[))+/;
terminal SINGLE_STRING_TEXT: /(\\.|[^'\\\[]|\[(?!\[))+/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
