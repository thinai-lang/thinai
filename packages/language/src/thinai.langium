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
    'import'
    ('{' components+=ImportComponent (',' components+=ImportComponent)* '}' 'from' path=StringLiteral
    | path=StringLiteral ('as' alias=ID)?) ';'?;

ImportComponent:
    component=[ImportableComponent:QualifiedName] ('as' alias=ID)?;


BoundedContext:
    'bounded' 'context' name=ID
    ('realizes' subdomains+=[Subdomain:QualifiedName] (',' subdomains+=[Subdomain:QualifiedName])*)?
    '{'
        members+=ContextMember*
    '}' ';'?;

BoundedContextPart:
    'part' 'of' 'bounded' 'context' (contextPath+=[NamedDeclaration:ID] '.')* context=[BoundedContext:ID] '{'
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
    'separateWays' (leftPath+=[NamedDeclaration:ID] '.')* left=[BoundedContext:ID]
    '-x-' (rightPath+=[NamedDeclaration:ID] '.')* right=[BoundedContext:ID] ';'?;

SharedKernelRelationship:
    'sharedKernel' (sharedKernelPath+=[NamedDeclaration:ID] '.')* sharedKernel=[SharedKernel:ID] '{'
        'participants' ':' '[' participants+=[BoundedContext:QualifiedName] (',' participants+=[BoundedContext:QualifiedName])* ']' ';'?
    '}' ';'?;

ContextMapEndpoint:
    (contextPath+=[NamedDeclaration:ID] '.')* context=[BoundedContext:ID]
    ('{' 'integrationPatterns' ':' '[' integrationPatterns+=StringLiteral (',' integrationPatterns+=StringLiteral)* ']' ';'? '}')?;

ApplicationService:
    'application' 'service' name=ID 'for' (aggregatePath+=[NamedDeclaration:ID] '.')* aggregate=[Aggregate:ID] '{'
        methods+=Method*
    '}' ';'?;

ContextMember:
    ApplicationService
    | QueryService
    | Projector
    | Capability
    | Aggregate
    | DomainService
    | Repository
    | QueryRepository
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
    | QueryService
    | Projector
    | Capability
    | Aggregate
    | DomainService
    | Repository
    | QueryRepository
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
    (root?='root')? 'entity' name=ID ('extends' (basePath+=[NamedDeclaration:ID] '.')* base=[Entity:ID])?
    '{' constructors+=Constructor* methods+=Method* fields+=Field* '}' ';'?;

ValueObject:
    'value' 'object' name=ID
    ('mirrors' (mirrorsPath+=[NamedDeclaration:ID] '.')* mirrors=[ValueObject:ID])?
    '{' constructors+=Constructor* methods+=Method* fields+=Field* '}' ';'?;

EnumType:
    'enum' name=ID '{' values+=EnumValue (','? values+=EnumValue)* '}' ';'?;

EnumValue:
    name=ID;

Field:
    (identifier?='identifier')? name=ID (optional?='?')? ':'
    (primitive=PrimitiveType | (typePath+=[NamedDeclaration:ID] '.')* type=[TypeDeclaration:ID] | collection=CollectionType)
    ('initial' initialState=ID)? ';'?;

Invariant:
    'invariant' description=SpecificationText ';'?;

Precondition:
    'precondition' description=SpecificationText ';'?;

Postcondition:
    'postcondition' description=SpecificationText ';'?;

Behavior:
    'behavior' description=SpecificationText ';'?;

TypeDeclaration:
    Entity
    | ValueObject
    | EnumType
    | ReadModel
    | DataObject;

ReadModel:
    'read' 'model' name=ID '{' fields+=Field* '}' ';'?;

DataObject:
    'data' 'object' name=ID '{' fields+=Field* '}' ';'?;

Projector:
    'projector' name=ID 'for' (readModelPath+=[NamedDeclaration:ID] '.')* readModel=[ReadModel:ID] '{' methods+=Method* '}' ';'?;

DomainService:
    'domain' 'service' name=ID ('{' methods+=Method* '}')? ';'?;

Method:
    'method' name=ID '(' (parameters+=Parameter (',' parameters+=Parameter)*)? ')'
    ('returns' (returnPrimitive=PrimitiveType | (returnTypePath+=[NamedDeclaration:ID] '.')* returnType=[TypeDeclaration:ID] | returnCollection=CollectionType))?
    ('{' (invariants+=Invariant | preconditions+=Precondition | postconditions+=Postcondition | behaviors+=Behavior | transitions+=Transition |
        invocations+=MethodInvocation |
        'emits' events+=[EventDeclaration:QualifiedName] (',' events+=[EventDeclaration:QualifiedName])* ';'?)* '}')? ';'?;

MethodInvocation:
    'invokes' targets+=[NamedDeclaration:ID] ('.' targets+=[NamedDeclaration:ID])* ';'?;

Transition:
    'transition' field=[Field:ID] 'from' from=[EnumValue:ID] 'to' to=[EnumValue:ID] ';'?;

Constructor:
    'constructor' '(' (parameters+=Parameter (',' parameters+=Parameter)*)? ')'
    ('{' (invariants+=Invariant | preconditions+=Precondition | postconditions+=Postcondition | behaviors+=Behavior)* '}')? ';'?;

Parameter:
    name=ID (optional?='?')? ':' ('event' (eventTypePath+=[NamedDeclaration:ID] '.')* eventType=[EventDeclaration:ID] |
        primitive=PrimitiveType | (typePath+=[NamedDeclaration:ID] '.')* type=[TypeDeclaration:ID] | collection=CollectionType);

Repository:
    'repository' name=ID 'for' (aggregatePath+=[NamedDeclaration:ID] '.')* aggregate=[Aggregate:ID] ';'?;

QueryRepository:
    'query' 'repository' name=ID 'for' (readModelPath+=[NamedDeclaration:ID] '.')* readModel=[ReadModel:ID] ';'?;

QueryService:
    'query' 'service' name=ID '{' methods+=Method* '}' ';'?;

Factory:
    'factory' name=ID 'for' (aggregatePath+=[NamedDeclaration:ID] '.')* aggregate=[Aggregate:ID]
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

type NamedDeclaration = Aggregate | ApplicationService | BoundedContext | Capability | ContextMap | DomainEvent | DomainService | Entity |
    DataObject | EnumType | Factory | Flow | IntegrationEvent | Method | Module | Projector | SharedKernel |
    QueryRepository | QueryService | ReadModel | Repository | Subdomain | ValueObject;

Flow:
    'flow' name=ID '{' elements+=FlowElement* '}' ';'?;

FlowElement:
    'actor' actor=ID ';'?
    | 'invoke' targets+=[NamedDeclaration:ID] ('.' targets+=[NamedDeclaration:ID])* ('with' arguments=SpecificationText)? ('when' guard=SpecificationText)? ';'?;

type ImportableComponent = BoundedContext | ContextMap | SharedKernel;

CollectionType:
    kind=CollectionKind '<'
    (elementPrimitive=PrimitiveType | (elementTypePath+=[NamedDeclaration:ID] '.')* elementType=[TypeDeclaration:ID] | elementCollection=CollectionType)
    (',' (valuePrimitive=PrimitiveType | (valueTypePath+=[NamedDeclaration:ID] '.')* valueType=[TypeDeclaration:ID] | valueCollection=CollectionType))?
    '>';

CollectionKind returns string:
    'List' | 'Set' | 'Map';

SpecificationText:
    DOUBLE_STRING_START (parts+=SpecificationTextPart)* DOUBLE_STRING_END
    | SINGLE_STRING_START (parts+=SpecificationTextPart)* SINGLE_STRING_END;

SpecificationTextPart:
    text=DOUBLE_STRING_TEXT
    | text=SINGLE_STRING_TEXT
    | '[[' target=[SpecificationTarget:ID] ('.' targets+=[SpecificationTarget:ID])* REFERENCE_END;

type SpecificationTarget = NamedDeclaration | EnumValue | Field | Parameter;

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
