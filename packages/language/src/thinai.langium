grammar Thinai

entry Model:
    (imports+=Import | declarations+=TopLevelDeclaration)*;

TopLevelDeclaration:
    Subdomain
    | BoundedContext
    | BoundedContextPart
    | ContextMap;

Import:
    'import' path=STRING ('as' alias=ID)? ';'?;

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
    | TypeDeclaration;

Subdomain:
    'subdomain' name=ID ('kind' kind=SubdomainKind)? ';'?;

Capability:
    'capability' name=ID ('owned' 'by' owner=[Actor:QualifiedName])? ';'?;

Aggregate:
    'aggregate' name=ID ('root' root=[Entity:QualifiedName])? '{'
        members+=AggregateMember*
    '}' ';'?;

AggregateMember:
    Entity
    | ValueObject
    | EnumType
    | DomainService
    | Repository
    | Factory;

Entity:
    'entity' name=ID ('extends' base=[Entity:QualifiedName])? ('{' fields+=Field* invariants+=Invariant* '}')? ';'?;

ValueObject:
    'value' 'object' name=ID ('{' fields+=Field* invariants+=Invariant* '}')? ';'?;

EnumType:
    'enum' name=ID '{' values+=EnumValue (','? values+=EnumValue)* '}' ';'?;

EnumValue:
    name=ID;

Field:
    name=ID ('?')? ':' (primitive=PrimitiveType | type=[TypeDeclaration:QualifiedName]) ';'?;

Invariant:
    'invariant' description=STRING ';'?;

TypeDeclaration:
    Entity
    | ValueObject
    | EnumType;

DomainService:
    'domain' 'service' name=ID ('{' methods+=ServiceMethod* '}')? ';'?;

ServiceMethod:
    'method' name=ID '(' (parameters+=Field (',' parameters+=Field)*)? ')' ('returns' (primitive=PrimitiveType | type=[TypeDeclaration:QualifiedName]))? ';'?;

Repository:
    'repository' name=ID 'for' aggregate=[Aggregate:QualifiedName] ';'?;

Factory:
    'factory' name=ID 'for' aggregate=[Aggregate:QualifiedName] ';'?;

Actor:
    'actor' name=ID ('role' role=STRING)? ';'?;

ExternalSystem:
    'external' 'system' name=ID ';'?;

Command:
    'command' name=ID
    ('handled' 'by' handler=[Actor:QualifiedName])?
    ('targets' aggregate=[Aggregate:QualifiedName])?
    ('with' fields+=Field (',' fields+=Field)*)?
    ('emits' events+=[EventDeclaration:QualifiedName] (',' events+=[EventDeclaration:QualifiedName])*)?
    ';'?;

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

Policy:
    'policy' name=ID
    'when' triggers+=[EventDeclaration:QualifiedName] (',' triggers+=[EventDeclaration:QualifiedName])*
    'then' commands+=[Command:QualifiedName] (',' commands+=[Command:QualifiedName])* ';'?;

ReadModel:
    'read' 'model' name=ID ('from' events+=[EventDeclaration:QualifiedName] (',' events+=[EventDeclaration:QualifiedName])*)? ';'?;

Hotspot:
    'hotspot' name=ID ('note' description=STRING)? ';'?;

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
terminal STRING: /"(\\.|[^"\\])*"|'(\\.|[^'\\])*'/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
