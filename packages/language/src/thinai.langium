grammar Thinai

entry Model:
    (imports+=Import | declarations+=TopLevelDeclaration)*;

TopLevelDeclaration:
    SharedKernel
    | Subdomain
    | BoundedContext
    | BoundedContextPart
    | ContextMap
    | Actor
    | Journey;

Import:
    'import'
    ('{' components+=ImportComponent (',' components+=ImportComponent)* '}' 'from' path=StringLiteral
    | path=StringLiteral);

ImportComponent:
    component=[ImportableComponent:ID] ('as' alias=[ImportableComponent:ID])?;


BoundedContext:
    'bounded' 'context' name=ID
    ('realizes' subdomains+=SubdomainReference (',' subdomains+=SubdomainReference)*)?;

BoundedContextPart:
    'in' 'bounded' 'context' (contextPath+=[NamedDeclaration:ID] '.')* context=[BoundedContext:ID] '{'
        members+=ContextMember*
    '}' ;

ContextMap:
    'context' 'map' name=ID '{'
        relationships+=ContextRelationship*
    '}' ;

ContextRelationship:
    CustomerSupplierRelationship
    | PartnershipRelationship
    | SeparateWaysRelationship
    | SharedKernelRelationship;

CustomerSupplierRelationship:
    'customer' customer=ContextMapEndpoint '->' 'supplier' supplier=ContextMapEndpoint ;

PartnershipRelationship:
    'partner' left=ContextMapEndpoint '<->' 'partner' right=ContextMapEndpoint ;

SeparateWaysRelationship:
    'separateWays' (leftPath+=[NamedDeclaration:ID] '.')* left=[BoundedContext:ID]
    '-x-' (rightPath+=[NamedDeclaration:ID] '.')* right=[BoundedContext:ID] ;

SharedKernelRelationship:
    'sharedKernel' (sharedKernelPath+=[NamedDeclaration:ID] '.')* sharedKernel=[SharedKernel:ID] '{'
        'participants' ':' '[' participants+=BoundedContextReference (',' participants+=BoundedContextReference)* ']'
    '}' ;

ContextMapEndpoint:
    (contextPath+=[NamedDeclaration:ID] '.')* context=[BoundedContext:ID]
    ('{' 'integrationPatterns' ':' '[' integrationPatterns+=StringLiteral (',' integrationPatterns+=StringLiteral)* ']' '}')?;

ApplicationService:
    'application' 'service' name=ID '{'
        methods+=Method*
    '}' ;

ContextMember:
    ApplicationService
    | QueryService
    | Projector
    | Aggregate
    | DomainService
    | Repository
    | QueryRepository
    | Factory
    | DomainEvent
    | IntegrationEvent
    | Module
    | TypeDeclaration;

SharedKernel:
    'shared' 'kernel' name=ID '{'
        members+=SharedKernelMember*
    '}' ;

SharedKernelMember:
    ValueObject
    | EnumType
    | DomainService
    | Module;

Module:
    'module' name=ID
    ('depends' 'on' dependencies+=ModuleReference (',' dependencies+=ModuleReference)*)?
    '{'
        exposures+=Exposure*
        members+=ModuleMember*
    '}' ;

Exposure:
    'exposes' declarations+=NamedDeclarationReference (',' declarations+=NamedDeclarationReference)* ;

// Modules expose declarations; fields, parameters, and enum values inherit
// visibility from their containing declaration.
type ExposableDeclaration = Aggregate | ApplicationService | DomainEvent | DomainService | Entity |
    DataObject | EnumType | Factory | IntegrationEvent | Method | Module | Projector | QueryRepository |
    QueryService | ReadModel | Repository | ValueObject;

ModuleMember:
    ApplicationService
    | QueryService
    | Projector
    | Aggregate
    | DomainService
    | Repository
    | QueryRepository
    | Factory
    | DomainEvent
    | IntegrationEvent
    | Module
    | TypeDeclaration;

Subdomain:
    'subdomain' name=ID ('kind' kind=SubdomainKind)? ;

Aggregate:
    'aggregate' name=ID '{'
        (members+=AggregateMember | invariants+=Invariant)*
    '}' ;

AggregateMember:
    Entity
    | ValueObject
    | EnumType;

Entity:
    (root?='root')? 'entity' name=ID
    '{' (constructors+=Constructor | methods+=Method | fields+=Field)* '}' ;

ValueObject:
    'value' 'object' name=ID
    ('mirrors' (mirrorsPath+=[NamedDeclaration:ID] '.')* mirrors=[ValueObject:ID])?
    '{' (constructors+=Constructor | methods+=Method | fields+=Field)* '}' ;

EnumType:
    'enum' name=ID '{' values+=EnumValue (','? values+=EnumValue)* '}' ;

EnumValue:
    name=ID;

Field:
    (identifier?='identifier')? name=ID (optional?='?')? ':'
    (primitive=PrimitiveType | (typePath+=[NamedDeclaration:ID] '.')* type=[TypeDeclaration:ID] | collection=CollectionType)
    ('initial' initialState=[EnumValue:ID])? ;

Invariant:
    'invariant' description=SpecificationText ;

Precondition:
    'precondition' description=SpecificationText ;

Postcondition:
    'postcondition' description=SpecificationText ;

Behavior:
    'behavior' description=SpecificationText ;

TypeDeclaration:
    Entity
    | ValueObject
    | EnumType
    | ReadModel
    | DataObject;

ReadModel:
    'read' 'model' name=ID '{' fields+=Field* '}' ;

DataObject:
    'data' 'object' name=ID '{' fields+=Field* '}' ;

Projector:
    'projector' name=ID '{' methods+=Method* '}' ;

DomainService:
    'domain' 'service' name=ID ('{' methods+=Method* '}')? ;

Method:
    'method' name=ID '(' (parameters+=Parameter (',' parameters+=Parameter)*)? ')'
    ('returns' (returnPrimitive=PrimitiveType | (returnTypePath+=[NamedDeclaration:ID] '.')* returnType=[TypeDeclaration:ID] | returnCollection=CollectionType))?
    ('{' (invariants+=Invariant | preconditions+=Precondition | postconditions+=Postcondition | behaviors+=Behavior |
        transitions+=Transition | emissions+=EventEmission | invocations+=MethodInvocation | reads+=ReadDependency |
        'projects' projects+=ReadModelReference (',' projects+=ReadModelReference)*)* '}')?;

MethodInvocation:
    'invokes' targets+=[NamedDeclaration:ID] ('.' targets+=[NamedDeclaration:ID])* ('when' guard=SpecificationText)? ;

Transition:
    'transition' changes+=TransitionChange (',' changes+=TransitionChange)* ('when' guard=SpecificationText)?;

TransitionChange:
    field=[Field:ID] 'from' from=[EnumValue:ID] 'to' to=[EnumValue:ID];

EventEmission:
    'emits' events+=EventReference (',' events+=EventReference)* ('when' guard=SpecificationText)?;

ReadDependency:
    'reads' 'from' sources+=ReadSourceReference (',' sources+=ReadSourceReference)*
    ('when' guard=SpecificationText)?;

Constructor:
    'constructor' '(' (parameters+=Parameter (',' parameters+=Parameter)*)? ')'
    ('{' (invariants+=Invariant | preconditions+=Precondition | postconditions+=Postcondition | behaviors+=Behavior)* '}')? ;

Parameter:
    name=ID (optional?='?')? ':'
    (primitive=PrimitiveType | (typePath+=[NamedDeclaration:ID] '.')* type=[ParameterType:ID] | collection=CollectionType);

Repository:
    'repository' name=ID '{' 'manages' (rootPath+=[NamedDeclaration:ID] '.')* root=[Entity:ID] '}' ;

QueryRepository:
    'query' 'repository' name=ID '{' 'serves' (readModelPath+=[NamedDeclaration:ID] '.')* readModel=[ReadModel:ID]
        ('reads' 'from' sources+=AggregateReference (',' sources+=AggregateReference)*)? '}' ;

QueryService:
    'query' 'service' name=ID '{' methods+=Method* '}' ;

Factory:
    'factory' name=ID
    ('{' methods+=Method* '}')? ;

DomainEvent:
    'event' name=ID
    ('{' fields+=Field* '}')?;

IntegrationEvent:
    'integration' 'event' name=ID
    ('{' fields+=Field* '}')?;

type EventDeclaration = DomainEvent | IntegrationEvent;
type ParameterType = TypeDeclaration | EventDeclaration;

SubdomainReference:
    (path+=[NamedDeclaration:ID] '.')* target=[Subdomain:ID];

BoundedContextReference:
    (path+=[NamedDeclaration:ID] '.')* target=[BoundedContext:ID];

ModuleReference:
    (path+=[NamedDeclaration:ID] '.')* target=[Module:ID];

NamedDeclarationReference:
    (path+=[ExposableDeclaration:ID] '.')* target=[ExposableDeclaration:ID];

EventReference:
    (path+=[NamedDeclaration:ID] '.')* target=[EventDeclaration:ID];

ReadModelReference:
    (path+=[NamedDeclaration:ID] '.')* target=[ReadModel:ID];

ReadSourceReference:
    (path+=[NamedDeclaration:ID] '.')* target=[NamedDeclaration:ID];

AggregateReference:
    (path+=[NamedDeclaration:ID] '.')* target=[Aggregate:ID];

type NamedDeclaration = Aggregate | ApplicationService | BoundedContext | ContextMap | DomainEvent | DomainService | Entity |
    DataObject | EnumType | Factory | IntegrationEvent | Method | Module | Projector | SharedKernel |
    QueryRepository | QueryService | ReadModel | Repository | Subdomain | ValueObject;

Actor:
    'actor' name=ID ;

Journey:
    'journey' name=ID '{' actors+=JourneyActor* '}' ;

JourneyActor:
    'by' actor=[Actor:ID] '{' steps+=JourneyStep* '}';

JourneyStep:
    'invoke' targets+=[NamedDeclaration:ID] ('.' targets+=[NamedDeclaration:ID])* ('with' arguments=SpecificationText)? ('when' guard=SpecificationText)? ;

type ImportableComponent = BoundedContext | ContextMap | SharedKernel;

CollectionType:
    kind=CollectionKind '<'
    (elementPrimitive=PrimitiveType | (elementTypePath+=[NamedDeclaration:ID] '.')* elementType=[TypeDeclaration:ID] | elementCollection=CollectionType)
    (',' (valuePrimitive=PrimitiveType | (valueTypePath+=[NamedDeclaration:ID] '.')* valueType=[TypeDeclaration:ID] | valueCollection=CollectionType))?
    '>';

CollectionKind returns string:
    'List' | 'Set' | 'Map';

SpecificationText:
    TRIPLE_DOUBLE_STRING_START (parts+=SpecificationTextPart)* TRIPLE_DOUBLE_STRING_END
    | DOUBLE_STRING_START (parts+=SpecificationTextPart)* DOUBLE_STRING_END
    | SINGLE_STRING_START (parts+=SpecificationTextPart)* SINGLE_STRING_END;

SpecificationTextPart:
    text=TRIPLE_DOUBLE_STRING_TEXT
    | text=DOUBLE_STRING_TEXT
    | text=SINGLE_STRING_TEXT
    | '[[' target=[SpecificationTarget:ID] ('.' targets+=[SpecificationTarget:ID])* REFERENCE_END;

type SpecificationTarget = NamedDeclaration | EnumValue | Field | Parameter;

StringLiteral returns string:
    TRIPLE_DOUBLE_STRING_START TRIPLE_DOUBLE_STRING_TEXT? TRIPLE_DOUBLE_STRING_END
    | DOUBLE_STRING_START DOUBLE_STRING_TEXT? DOUBLE_STRING_END
    | SINGLE_STRING_START SINGLE_STRING_TEXT? SINGLE_STRING_END;

PrimitiveType returns string:
    'string' | 'number' | 'boolean' | 'date' | 'time' | 'instant';

SubdomainKind returns string:
    'core' | 'supporting' | 'generic';

hidden terminal WS: /\s+/;
terminal ID: /[_a-zA-Z][\w_]*/;
terminal TRIPLE_DOUBLE_STRING_START: /"""/;
terminal TRIPLE_DOUBLE_STRING_END: /\u0000"""/;
terminal TRIPLE_DOUBLE_STRING_TEXT: /(\\.|"(?!"\")|[^"\\\[]|\[(?!\[))+/;
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
