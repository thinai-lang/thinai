export const INTEGRATION_PATTERNS = new Set([
    'Conformist',
    'AntiCorruptionLayer',
    'OpenHostService',
    'PublishedLanguage'
]);

/** Words that cannot be used as bare identifiers by the grammar. */
export const THINAI_KEYWORDS = new Set([
    'actor', 'aggregate', 'application', 'as', 'behavior', 'boolean', 'bounded',
    'by', 'constructor', 'context', 'core', 'customer', 'data', 'date', 'depends', 'domain',
    'emits', 'entity', 'enum', 'event', 'exposes', 'factory', 'from', 'generic',
    'identifier', 'import', 'in', 'initial', 'instant', 'integration',
    'integrationPatterns', 'invariant', 'invoke', 'invokes', 'journey', 'kernel',
    'kind', 'List', 'manages', 'Map', 'map', 'method', 'mirrors', 'model', 'module',
    'number', 'object', 'on', 'participants', 'partner', 'postcondition', 'precondition',
    'projector', 'projects', 'query', 'read', 'reads', 'realizes', 'repository',
    'returns', 'root', 'separateWays', 'serves', 'service', 'Set', 'shared',
    'sharedKernel', 'string', 'subdomain', 'supplier', 'supporting', 'time',
    'to', 'transition', 'value', 'when', 'with'
]);
