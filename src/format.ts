import { formatDate } from './date';
import { astOf } from './lower';
import { formatLiteral, formatTextTerm, quote } from './scan';
import type { QueryInput, QueryNode, Value } from './types';

const OPERATOR_TEXT = { eq: '', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;

export function format(query: QueryInput): string {
    const ast = astOf(query);
    return ast ? formatNode(ast) : '';
}

function formatNode(node: QueryNode): string {
    switch (node.type) {
        case 'or':
            return node.children
                .map(child => (child.type === 'or' ? `(${formatNode(child)})` : formatNode(child)))
                .join(' OR ');
        case 'and':
            return node.children
                .map(child =>
                    child.type === 'or' || child.type === 'and'
                        ? `(${formatNode(child)})`
                        : formatNode(child)
                )
                .join(' ');
        case 'not': {
            const child = node.child;
            return child.type === 'or' || child.type === 'and'
                ? `-(${formatNode(child)})`
                : `-${formatNode(child)}`;
        }
        case 'text':
            return node.quoted ? quote(node.value) : formatTextTerm(node.value);
        case 'exists':
            return `has:${node.field}`;
        case 'shortcut':
            return `${node.name}:${node.values.map(formatLiteral).join(',')}`;
        case 'filter':
            switch (node.op) {
                case 'in':
                    return `${node.field}:${node.values.map(formatValue).join(',')}`;
                case 'range':
                    return `${node.field}:${node.min ? formatValue(node.min) : '*'}..${node.max ? formatValue(node.max) : '*'}`;
                default:
                    return `${node.field}:${OPERATOR_TEXT[node.op]}${formatValue(node.value)}`;
            }
    }
}

export function formatValue(value: Value): string {
    switch (value.kind) {
        case 'string': {
            const core = formatLiteral(value.value);
            if (value.wildcard === 'prefix') return `${core}*`;
            if (value.wildcard === 'suffix') return `*${core}`;
            if (value.wildcard === 'contains') return `*${core}*`;
            return core;
        }
        case 'enum':
            return formatLiteral(value.value);
        case 'number':
        case 'boolean':
            return String(value.value);
        case 'date':
            return formatDate(value.value);
        case 'variable':
            return `@${value.name}`;
    }
}
