export type SearchqlErrorCode = 'missing-variable' | 'unsupported' | 'invalid-option';

export class SearchqlError extends Error {
    override readonly name = 'SearchqlError';

    constructor(
        readonly code: SearchqlErrorCode,
        message: string
    ) {
        super(message);
    }
}
