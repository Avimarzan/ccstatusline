import {
    readFileSync,
    readdirSync
} from 'fs';
import os from 'os';
import path from 'path';

import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type {
    CustomKeybind,
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';

import {
    isMetadataFlagEnabled,
    toggleMetadataFlag
} from './shared/metadata';

const HIDE_WHEN_EMPTY_KEY = 'hideWhenEmpty';
const LABEL_KEY = 'label';
const TOGGLE_HIDE_EMPTY_ACTION = 'toggle-hide-empty';

function readLabel(item: WidgetItem): string | undefined {
    const value = item.metadata?.[LABEL_KEY];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

interface RecommendationEntry {
    id?: unknown;
    superseded_by?: unknown;
    dismissed_by_decay_from?: unknown;
}

interface JsonlEntry {
    kind?: unknown;
    id?: unknown;
    proposal_id?: unknown;
    superseded_by?: unknown;
    dismissed_by_decay_from?: unknown;
    ts?: unknown;
}

// Reconsideration gate thresholds. SOURCE OF TRUTH:
// scripts/tools/feedback_gates.py (COUNT_GATE_N, TIME_GATE_DAYS) in the
// claude-toolkit repo. Mirrored here because the status line renders on every
// prompt and cannot shell out to Python per render. Keep in sync by hand — these
// constants change rarely. A skill is "owed" a reconsider when it has >= 5 new
// capture entries since its last reconsidered marker, OR >= 14 days have passed
// since that marker with at least one new entry waiting.
const COUNT_GATE_N = 5;
const TIME_GATE_DAYS = 14;
const MS_PER_DAY = 86_400_000;

export interface SelfImproveScan {
    /** Pending recommendations awaiting a TUI verdict across all avi- skills. */
    pending: number;
    /** Number of skills with a fired reconsider gate (captures awaiting reconsider). */
    owedSkills: number;
    /** Max age in days of the oldest unreconsidered entry among owed skills (0 if none). */
    maxAgeDays: number;
}

/**
 * Count pending self-improve recommendations across all avi- skill history files.
 *
 * Pending means: kind === 'recommendation', AND
 *   - no kind:verdict entry references the recommendation's id via proposal_id, AND
 *   - the recommendation has no superseded_by marker, AND
 *   - the recommendation has no dismissed_by_decay_from marker.
 *
 * Mirrors avi-skill-improve TUI lib/history.js findPendingRecommendations.
 * Tolerates malformed final lines (writer killed mid-append). Missing skills
 * directory or unreadable files are counted as zero — never throws.
 */
export function scanSelfImprove(skillsRoot: string, now: number = Date.now()): SelfImproveScan {
    let dirs: string[];
    try {
        dirs = readdirSync(skillsRoot);
    } catch {
        return { pending: 0, owedSkills: 0, maxAgeDays: 0 };
    }

    let pending = 0;
    let owedSkills = 0;
    let maxAgeDays = 0;

    for (const name of dirs) {
        if (!name.startsWith('avi-'))
            continue;
        const histPath = path.join(skillsRoot, name, '.history.jsonl');

        let raw: string;
        try {
            raw = readFileSync(histPath, 'utf-8');
        } catch {
            continue;
        }

        const verdictedIds = new Set<string>();
        const recommendations: RecommendationEntry[] = [];

        // Overdue tracking: count kind:entry rows appearing AFTER the last
        // kind:reconsidered marker, and remember the oldest such entry's ts.
        let newEntryCount = 0;
        let oldestNewEntryMs: number | null = null;

        for (const line of raw.split('\n')) {
            const s = line.trim();
            if (!s)
                continue;
            let entry: JsonlEntry;
            try {
                entry = JSON.parse(s) as JsonlEntry;
            } catch {
                continue;
            }
            if (entry.kind === 'verdict' && typeof entry.proposal_id === 'string') {
                verdictedIds.add(entry.proposal_id);
            } else if (entry.kind === 'recommendation') {
                recommendations.push(entry as RecommendationEntry);
            } else if (entry.kind === 'reconsidered') {
                // A reconsider pass ran here — everything before it is accounted
                // for, so reset the unreconsidered-entry tally.
                newEntryCount = 0;
                oldestNewEntryMs = null;
            } else if (entry.kind === 'entry') {
                newEntryCount++;
                if (typeof entry.ts === 'string') {
                    const ms = Date.parse(entry.ts);
                    if (!Number.isNaN(ms) && (oldestNewEntryMs === null || ms < oldestNewEntryMs)) {
                        oldestNewEntryMs = ms;
                    }
                }
            }
        }

        for (const rec of recommendations) {
            if (typeof rec.id === 'string' && verdictedIds.has(rec.id))
                continue;
            if (rec.superseded_by)
                continue;
            if (rec.dismissed_by_decay_from)
                continue;
            pending++;
        }

        // ageDays is 0 unless at least one new (post-marker) entry carried a
        // parseable ts, so `ageDays >= TIME_GATE_DAYS` already implies a fresh
        // dated entry exists — no separate "has new entry" guard is needed for
        // the time gate. The count gate covers entries with missing timestamps.
        const ageDays = oldestNewEntryMs === null ? 0 : (now - oldestNewEntryMs) / MS_PER_DAY;
        const countGateFired = newEntryCount >= COUNT_GATE_N;
        const timeGateFired = ageDays >= TIME_GATE_DAYS;
        if (countGateFired || timeGateFired) {
            owedSkills++;
            if (ageDays > maxAgeDays)
                maxAgeDays = ageDays;
        }
    }

    return { pending, owedSkills, maxAgeDays };
}

/**
 * Count pending self-improve recommendations across all avi- skill history files.
 * Thin wrapper over {@link scanSelfImprove} preserved for existing consumers.
 */
export function countPendingSelfImproveRecommendations(skillsRoot: string): number {
    return scanSelfImprove(skillsRoot).pending;
}

function defaultSkillsRoot(): string {
    return path.join(os.homedir(), '.claude', 'skills');
}

export class PendingSelfImproveWidget implements Widget {
    private readonly skillsRoot: string;

    constructor(skillsRoot?: string) {
        this.skillsRoot = skillsRoot ?? defaultSkillsRoot();
    }

    getDefaultColor(): string { return 'yellow'; }
    getDescription(): string { return 'Count of pending self-improve recommendations across avi- skills'; }
    getDisplayName(): string { return 'Pending Self-Improve'; }
    getCategory(): string { return 'Session'; }
    supportsRawValue(): boolean { return true; }
    supportsColors(_item: WidgetItem): boolean { return true; }

    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        const modifiers: string[] = [];
        if (isMetadataFlagEnabled(item, HIDE_WHEN_EMPTY_KEY)) {
            modifiers.push('hide when empty');
        }
        const label = readLabel(item);
        if (label !== undefined) {
            modifiers.push(`label: ${label}`);
        }
        return {
            displayText: this.getDisplayName(),
            modifierText: modifiers.length > 0 ? `(${modifiers.join(', ')})` : undefined
        };
    }

    getCustomKeybinds(): CustomKeybind[] {
        return [
            { key: 'h', label: '(h)ide when empty', action: TOGGLE_HIDE_EMPTY_ACTION }
        ];
    }

    handleEditorAction(action: string, item: WidgetItem): WidgetItem | null {
        if (action === TOGGLE_HIDE_EMPTY_ACTION) {
            return toggleMetadataFlag(item, HIDE_WHEN_EMPTY_KEY);
        }
        return null;
    }

    render(item: WidgetItem, context: RenderContext, _settings: Settings): string | null {
        const raw = item.rawValue;
        const label = readLabel(item);

        if (context.isPreview) {
            if (raw)
                return '3';
            return label !== undefined ? `${label} 3` : '📝 3';
        }

        const scan = scanSelfImprove(this.skillsRoot);

        // Actionable pending recommendations win — show the count.
        if (scan.pending > 0) {
            if (raw)
                return String(scan.pending);
            return label !== undefined ? `${label} ${scan.pending}` : `📝 ${scan.pending}`;
        }

        // Zero pending, but a reconsider gate has fired: surface that captures
        // are awaiting reconsider so a stale pipeline does not hide behind "0".
        // Format: "<glyph> <owedSkills> / <maxAgeDays>d".
        if (scan.owedSkills > 0) {
            const body = `⏳ ${scan.owedSkills} / ${Math.floor(scan.maxAgeDays)}d`;
            if (raw)
                return body;
            return label !== undefined ? `${label} ${body}` : `📝 ${body}`;
        }

        // Genuinely idle: nothing pending, nothing owed.
        if (isMetadataFlagEnabled(item, HIDE_WHEN_EMPTY_KEY)) {
            return null;
        }
        if (raw)
            return '0';
        return label !== undefined ? `${label} 0` : '📝 0';
    }

    getNumericValue(_context: RenderContext, _item: WidgetItem): number | null {
        return countPendingSelfImproveRecommendations(this.skillsRoot);
    }
}