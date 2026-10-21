import { DatabaseSync } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { Query } from 'mingo';
import type { Issue } from './dataset';

export type Ids = number[];

export function createSqlite(rows: readonly Issue[]): (sql: string, params: unknown[]) => Ids {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE issues (
        id INTEGER PRIMARY KEY, status TEXT, priority TEXT, author TEXT, assignee TEXT,
        label TEXT, title TEXT, comments INTEGER, score REAL, created TEXT, closed TEXT,
        draft INTEGER, key TEXT
    )`);
    const insert = db.prepare('INSERT INTO issues VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of rows) {
        insert.run(
            r.id,
            r.status,
            r.priority,
            r.author,
            r.assignee,
            JSON.stringify(r.label),
            r.title,
            r.comments,
            r.score,
            r.created.toISOString(),
            r.closed?.toISOString() ?? null,
            r.draft ? 1 : 0,
            r.key
        );
    }
    return (sql, params) =>
        db
            .prepare(`SELECT id FROM issues WHERE ${sql} ORDER BY id`)
            .all(...(params as never[]))
            .map(row => Number((row as { id: number }).id));
}

export async function createPostgres(
    rows: readonly Issue[]
): Promise<(sql: string, params: unknown[]) => Promise<Ids>> {
    const db = new PGlite();
    await db.exec(`CREATE TABLE issues (
        id int PRIMARY KEY, status text, priority text, author text, assignee text,
        label text[], title text, comments int, score double precision, created timestamptz,
        closed timestamptz, draft boolean, key text
    )`);
    for (const r of rows) {
        await db.query(
            'INSERT INTO issues VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
            [
                r.id,
                r.status,
                r.priority,
                r.author,
                r.assignee,
                r.label,
                r.title,
                r.comments,
                r.score,
                r.created,
                r.closed,
                r.draft,
                r.key,
            ]
        );
    }
    return async (sql, params) => {
        const result = await db.query<{ id: number }>(
            `SELECT id FROM issues WHERE ${sql} ORDER BY id`,
            params
        );
        return result.rows.map(row => row.id);
    };
}

export function runMongo(rows: readonly Issue[], filter: Record<string, unknown>): Ids {
    const query = new Query(filter);
    return rows.filter(row => query.test(row as never)).map(row => row.id);
}
