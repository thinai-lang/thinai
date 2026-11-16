export const INTEGRATION_PATTERNS = new Set([
    'Conformist',
    'AntiCorruptionLayer',
    'OpenHostService',
    'PublishedLanguage'
]);

/** Patterns conventionally used on the downstream/customer side. */
export const CUSTOMER_INTEGRATION_PATTERNS = new Set([
    'Conformist',
    'AntiCorruptionLayer'
]);

/** Patterns conventionally used on the upstream/supplier side. */
export const SUPPLIER_INTEGRATION_PATTERNS = new Set([
    'OpenHostService',
    'PublishedLanguage'
]);

/** Words that cannot be used as bare identifiers by the grammar. */
export const THINAI_KEYWORDS = new Set([
    'actor', 'aggregate', 'application', 'as', 'behavior', 'boolean', 'bounded',
    'by', 'constructor', 'context', 'core', 'customer', 'data', 'date', 'decimal',
    'depends', 'domain', 'emits', 'entity', 'enum', 'event', 'exposes', 'factory',
    'from', 'generic', 'identifier', 'import', 'in', 'initial', 'instant',
    'integer', 'integration', 'integrationPatterns', 'invariant', 'invoke',
    'invokes', 'journey', 'kernel', 'kind', 'List', 'manages', 'Map', 'map',
    'method', 'mirrors', 'model', 'module', 'object', 'on', 'participants',
    'partner', 'postcondition', 'precondition',
    'projector', 'projects', 'query', 'read', 'reads', 'realizes', 'repository',
    'returns', 'root', 'separateWays', 'serves', 'service', 'Set', 'shared',
    'sharedKernel', 'string', 'subdomain', 'supplier', 'supporting', 'time',
    'to', 'transition', 'value', 'when', 'with'
]);
