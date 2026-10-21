import { defineSchema } from '../define';

export const issues = defineSchema({
    fields: {
        status: { type: 'enum', values: ['open', 'closed', 'merged'], description: 'Issue state' },
        priority: { type: 'enum', values: ['low', 'medium', 'high', 'urgent'], ordered: true },
        author: { type: 'string', aliases: ['by'], variables: ['me'] },
        assignee: { type: 'string', nullable: true, variables: ['me'] },
        label: { type: 'string', multiple: true },
        title: { type: 'string', match: 'contains' },
        comments: { type: 'number', integer: true, min: 0 },
        score: { type: 'number' },
        created: { type: 'date' },
        closed: { type: 'date', nullable: true },
        draft: { type: 'boolean' },
        key: { type: 'string', caseSensitive: true },
    },
    text: ['title'],
    shortcuts: {
        is: {
            open: 'status:open',
            closed: 'status:closed,merged',
            draft: 'draft:true',
            unassigned: 'no:assignee',
        },
    },
});
