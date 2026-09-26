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
    source=[BoundedContext:QualifiedName] relationship=RelationshipKind target=[BoundedContext:QualifiedName] ';'?;

ContextMember:
    Capability
    | Aggregate
    | DomainService
    | Repository
    | Factory
    | Actor
    | ExternalSystem
    | Command
    | DomainEvent
    | IntegrationEvent
    | Policy
    | ReadModel
    | Hotspot
    | EventStorming
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
    Capability
    | Aggregate
    | DomainService
    | Repository
    | Factory
    | Actor
    | ExternalSystem
    | Command
    | DomainEvent
    | IntegrationEvent
    | Policy
    | ReadModel
    | Hotspot
    | EventStorming
    | Module
    | TypeDeclaration;

Subdomain:
    'subdomain' name=ID ('kind' kind=SubdomainKind)? ';'?;

Capability:
    'capability' name=ID ('owned' 'by' owner=[Actor:QualifiedName])? ';'?;

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
    ('operations' '{' constructors+=Constructor* methods+=Method* '}')?
    ('{' fields+=Field* invariants+=Invariant* '}')? ';'?;

ValueObject:
    (identifier?='identifier')? 'value' 'object' name=ID
    ('for' identifierOf=[Entity:QualifiedName])?
    ('mirrors' mirrors=[ValueObject:QualifiedName])?
    ('operations' '{' constructors+=Constructor* methods+=Method* '}')?
    ('{' fields+=Field* invariants+=Invariant* '}')? ';'?;

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
    ('{' (invariants+=Invariant | preconditions+=Precondition | postconditions+=Postcondition | behaviors+=Behavior)* '}')? ';'?;

Constructor:
    'constructor' '(' (parameters+=Parameter (',' parameters+=Parameter)*)? ')'
    ('{' (invariants+=Invariant | preconditions+=Precondition | postconditions+=Postcondition | behaviors+=Behavior)* '}')? ';'?;

Parameter:
    name=ID (optional?='?')? ':' (primitive=PrimitiveType | type=[TypeDeclaration:QualifiedName] | collection=CollectionType);

Repository:
    'repository' name=ID 'for' aggregate=[Aggregate:QualifiedName] ';'?;

Factory:
    'factory' name=ID 'for' aggregate=[Aggregate:QualifiedName] ';'?;

Actor:
    'actor' name=ID ('role' role=StringLiteral)? ';'?;

ExternalSystem:
    'external' 'system' name=ID ';'?;

Command:
    'command' name=ID
    ('handled' 'by' handler=[Actor:QualifiedName])?
    ('targets' aggregate=[Aggregate:QualifiedName])?
    ('with' fields+=Field (',' fields+=Field)*)?
    ('emits' events+=[EventDeclaration:QualifiedName] (',' events+=[EventDeclaration:QualifiedName])*)?
    ('{' (invariants+=Invariant | preconditions+=Precondition | postconditions+=Postcondition | behaviors+=Behavior)* '}')? ';'?;

DomainEvent:
    'event' name=ID
    ('caused' 'by' command=[Command:QualifiedName])?
    ('for' aggregate=[Aggregate:QualifiedName])?
    (publishesIntegration?='publishes' 'integration' (publishedAs=[IntegrationEvent:QualifiedName])?)?
    ('data' '{' fields+=Field* '}')?
    ';'?;

IntegrationEvent:
    'integration' 'event' name=ID
    ('from' source=[DomainEvent:QualifiedName])?
    ('data' '{' fields+=Field* '}')?
    ';'?;

type EventDeclaration = DomainEvent | IntegrationEvent;

type NamedDeclaration = Actor | Aggregate | BoundedContext | Capability | Command | DomainEvent | DomainService | Entity |
    EnumType | EventStorming | ExternalSystem | Factory | Hotspot | IntegrationEvent | Method | Module | Policy | ReadModel |
    Repository | Subdomain | ValueObject;

Policy:
    'policy' name=ID
    'when' triggers+=[EventDeclaration:QualifiedName] (',' triggers+=[EventDeclaration:QualifiedName])*
    'then' commands+=[Command:QualifiedName] (',' commands+=[Command:QualifiedName])* ';'?;

ReadModel:
    'read' 'model' name=ID ('from' events+=[EventDeclaration:QualifiedName] (',' events+=[EventDeclaration:QualifiedName])*)? ';'?;

Hotspot:
    'hotspot' name=ID ('note' description=StringLiteral)? ';'?;

EventStorming:
    'event' 'storming' name=ID '{'
        elements+=EventStormingElement*
    '}' ';'?;

EventStormingElement:
    'actor' actor=[Actor:QualifiedName] ';'?
    | 'command' command=[Command:QualifiedName] ';'?
    | 'event' event=[EventDeclaration:QualifiedName] ';'?
    | 'policy' policy=[Policy:QualifiedName] ';'?
    | 'aggregate' aggregate=[Aggregate:QualifiedName] ';'?
    | 'read' 'model' readModel=[ReadModel:QualifiedName] ';'?
    | 'external' 'system' externalSystem=[ExternalSystem:QualifiedName] ';'?
    | 'hotspot' hotspot=[Hotspot:QualifiedName] ';'?;

type ImportableComponent = BoundedContext | SharedKernel;

CollectionType:
    kind=CollectionKind '<'
    (elementPrimitive=PrimitiveType | elementType=[TypeDeclaration:QualifiedName] | elementCollection=CollectionType)
    (',' (valuePrimitive=PrimitiveType | valueType=[TypeDeclaration:QualifiedName] | valueCollection=CollectionType))?
    '>';

CollectionKind returns string:
    'List' | 'Set' | 'Map';

TemplateString:
    TEMPLATE_STRING_START (parts+=TemplateStringPart)* TEMPLATE_STRING_END
    | SINGLE_TEMPLATE_STRING_START (parts+=TemplateStringPart)* SINGLE_TEMPLATE_STRING_END;

BehaviorSpecificationText:
    plain=STRING
    | template=TemplateString;

TemplateStringPart:
    text=DOUBLE_STRING_TEXT
    | text=SINGLE_STRING_TEXT
    | '${' method=[Method:QualifiedName] INTERPOLATION_END;

StringLiteral returns string:
    STRING;

PrimitiveType returns string:
    'string' | 'number' | 'boolean' | 'date';

SubdomainKind returns string:
    'core' | 'supporting' | 'generic';

RelationshipKind returns string:
    'partnership'
    | 'customer' 'supplier'
    | 'conformist'
    | 'shared' 'kernel'
    | 'published' 'language'
    | 'open' 'host'
    | 'anti' 'corruption' 'layer'
    | 'separate' 'ways';

QualifiedName returns string:
    ID ('.' ID)*;

hidden terminal WS: /\s+/;
terminal ID: /[_a-zA-Z][\w_]*/;
terminal TEMPLATE_STRING_START: /\$"/;
terminal TEMPLATE_STRING_END: /"/;
terminal SINGLE_TEMPLATE_STRING_START: /\$'/;
terminal SINGLE_TEMPLATE_STRING_END: /'/;
terminal INTERPOLATION_END: /\}/;
terminal DOUBLE_STRING_TEXT: /(\\.|[^"\\$]|\$(?!\{))+/;
terminal SINGLE_STRING_TEXT: /(\\.|[^'\\$]|\$(?!\{))+/;
terminal STRING: /"(\\.|[^"\\])*"|'(\\.|[^'\\])*'/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
