export function editDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    let beforePrevious: number[] = [];
    let previous = Array.from({ length: b.length + 1 }, (_, j) => j);

    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let best = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                best = Math.min(best, beforePrevious[j - 2]! + 1);
            }
            current.push(best);
        }
        beforePrevious = previous;
        previous = current;
    }

    return previous[b.length]!;
}

export function closest(typed: string, candidates: Iterable<string>, limit = 3): string[] {
    const needle = typed.toLowerCase();
    const allowed = Math.max(1, Math.floor(needle.length / 3));
    const scored: { candidate: string; score: number }[] = [];
    const seen = new Set<string>();

    for (const candidate of candidates) {
        const key = candidate.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        let score = editDistance(needle, key);
        if (score > allowed && needle.length >= 3 && key.startsWith(needle)) {
            score = allowed;
        }
        if (score <= allowed) scored.push({ candidate, score });
    }

    return scored
        .sort((x, y) => x.score - y.score || x.candidate.localeCompare(y.candidate))
        .slice(0, limit)
        .map(entry => entry.candidate);
}
