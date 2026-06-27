import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import type {
    RenderContext,
    WidgetItem
} from '../../types';
import { DEFAULT_SETTINGS } from '../../types/Settings';
import {
    PendingSelfImproveWidget,
    countPendingSelfImproveRecommendations,
    scanSelfImprove
} from '../PendingSelfImprove';

let tmpRoot: string;

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-self-improve-'));
});

afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeHistory(skillName: string, lines: string[]): string {
    const skillDir = path.join(tmpRoot, skillName);
    fs.mkdirSync(skillDir, { recursive: true });
    const histPath = path.join(skillDir, '.history.jsonl');
    fs.writeFileSync(histPath, lines.join('\n') + '\n');
    return histPath;
}

describe('countPendingSelfImproveRecommendations', () => {
    it('returns 0 when skills directory does not exist', () => {
        const missing = path.join(tmpRoot, 'does-not-exist');
        expect(countPendingSelfImproveRecommendations(missing)).toBe(0);
    });

    it('returns 0 when skills directory has no avi- subdirs', () => {
        fs.mkdirSync(path.join(tmpRoot, 'other-skill'), { recursive: true });
        expect(countPendingSelfImproveRecommendations(tmpRoot)).toBe(0);
    });

    it('returns 0 when avi- skill has no history file', () => {
        fs.mkdirSync(path.join(tmpRoot, 'avi-foo'), { recursive: true });
        expect(countPendingSelfImproveRecommendations(tmpRoot)).toBe(0);
    });

    it('returns 0 when history has only kind:entry lines', () => {
        writeHistory('avi-foo', [
            JSON.stringify({ kind: 'entry', id: 'e1', skill: 'avi-foo', ts: '2026-05-24T00:00:00Z', trigger: 'x' })
        ]);
        expect(countPendingSelfImproveRecommendations(tmpRoot)).toBe(0);
    });

    it('counts a single pending recommendation', () => {
        writeHistory('avi-foo', [
            JSON.stringify({ kind: 'entry', id: 'e1', skill: 'avi-foo', ts: '2026-05-24T00:00:00Z', trigger: 'x' }),
            JSON.stringify({ kind: 'recommendation', id: 'r1', total: 0.7 })
        ]);
        expect(countPendingSelfImproveRecommendations(tmpRoot)).toBe(1);
    });

    it('excludes verdicted recommendations', () => {
        writeHistory('avi-foo', [
            JSON.stringify({ kind: 'recommendation', id: 'r1', total: 0.7 }),
            JSON.stringify({ kind: 'verdict', proposal_id: 'r1', verdict: 'accept' })
        ]);
        expect(countPendingSelfImproveRecommendations(tmpRoot)).toBe(0);
    });

    it('excludes superseded recommendations', () => {
        writeHistory('avi-foo', [
            JSON.stringify({ kind: 'recommendation', id: 'r1', total: 0.7, superseded_by: 'r2' }),
            JSON.stringify({ kind: 'recommendation', id: 'r2', total: 0.8 })
        ]);
        expect(countPendingSelfImproveRecommendations(tmpRoot)).toBe(1);
    });

    it('excludes dismissed-by-decay recommendations', () => {
        writeHistory('avi-foo', [
            JSON.stringify({ kind: 'recommendation', id: 'r1', total: 0.1, dismissed_by_decay_from: 'app1' })
        ]);
        expect(countPendingSelfImproveRecommendations(tmpRoot)).toBe(0);
    });

    it('aggregates pending counts across multiple avi- skills', () => {
        writeHistory('avi-foo', [
            JSON.stringify({ kind: 'recommendation', id: 'r1', total: 0.7 }),
            JSON.stringify({ kind: 'recommendation', id: 'r2', total: 0.5 })
        ]);
        writeHistory('avi-bar', [
            JSON.stringify({ kind: 'recommendation', id: 'r3', total: 0.6 })
        ]);
        writeHistory('avi-baz', [
            JSON.stringify({ kind: 'recommendation', id: 'r4', total: 0.4 }),
            JSON.stringify({ kind: 'verdict', proposal_id: 'r4', verdict: 'reject' })
        ]);
        expect(countPendingSelfImproveRecommendations(tmpRoot)).toBe(3);
    });

    it('ignores non-avi- prefixed directories', () => {
        writeHistory('not-avi-skill', [
            JSON.stringify({ kind: 'recommendation', id: 'rx', total: 0.9 })
        ]);
        writeHistory('avi-real', [
            JSON.stringify({ kind: 'recommendation', id: 'r1', total: 0.5 })
        ]);
        expect(countPendingSelfImproveRecommendations(tmpRoot)).toBe(1);
    });

    it('tolerates malformed final line (writer killed mid-append)', () => {
        const skillDir = path.join(tmpRoot, 'avi-foo');
        fs.mkdirSync(skillDir, { recursive: true });
        const histPath = path.join(skillDir, '.history.jsonl');
        const goodLine = JSON.stringify({ kind: 'recommendation', id: 'r1', total: 0.7 });
        fs.writeFileSync(histPath, goodLine + '\n' + '{"kind":"recom');
        expect(countPendingSelfImproveRecommendations(tmpRoot)).toBe(1);
    });

    it('tolerates malformed lines mid-file', () => {
        writeHistory('avi-foo', [
            JSON.stringify({ kind: 'recommendation', id: 'r1', total: 0.7 }),
            '{not json at all',
            JSON.stringify({ kind: 'recommendation', id: 'r2', total: 0.6 })
        ]);
        expect(countPendingSelfImproveRecommendations(tmpRoot)).toBe(2);
    });

    it('skips blank lines', () => {
        writeHistory('avi-foo', [
            JSON.stringify({ kind: 'recommendation', id: 'r1', total: 0.7 }),
            '',
            '   ',
            JSON.stringify({ kind: 'recommendation', id: 'r2', total: 0.6 })
        ]);
        expect(countPendingSelfImproveRecommendations(tmpRoot)).toBe(2);
    });
});

describe('scanSelfImprove — overdue gate detection', () => {
    // Fixed reference clock so age math is deterministic.
    const NOW = Date.parse('2026-06-27T00:00:00Z');
    const daysAgo = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();

    function entry(ts: string): string {
        return JSON.stringify({ kind: 'entry', id: `e-${ts}`, skill: 'avi-foo', ts, trigger: 'x' });
    }
    function reconsidered(ts: string): string {
        return JSON.stringify({ kind: 'reconsidered', id: `m-${ts}`, skill: 'avi-foo', ts });
    }

    it('counts a skill owed via the count gate (>= 5 new entries)', () => {
        writeHistory('avi-foo', [
            entry(daysAgo(3)), entry(daysAgo(3)), entry(daysAgo(2)),
            entry(daysAgo(2)), entry(daysAgo(1))
        ]);
        const scan = scanSelfImprove(tmpRoot, NOW);
        expect(scan.owedSkills).toBe(1);
        expect(scan.pending).toBe(0);
        expect(Math.floor(scan.maxAgeDays)).toBe(3);
    });

    it('counts a skill owed via the time gate (1 entry, >= 14 days old)', () => {
        writeHistory('avi-foo', [entry(daysAgo(20))]);
        const scan = scanSelfImprove(tmpRoot, NOW);
        expect(scan.owedSkills).toBe(1);
        expect(Math.floor(scan.maxAgeDays)).toBe(20);
    });

    it('does NOT count a skill with new entries but reconsidered recently', () => {
        // Two fresh entries, but a reconsidered marker AFTER them resets the tally.
        writeHistory('avi-foo', [
            entry(daysAgo(30)), entry(daysAgo(29)),
            reconsidered(daysAgo(1))
        ]);
        const scan = scanSelfImprove(tmpRoot, NOW);
        expect(scan.owedSkills).toBe(0);
        expect(scan.maxAgeDays).toBe(0);
    });

    it('counts entries appearing after a reconsidered marker', () => {
        writeHistory('avi-foo', [
            entry(daysAgo(40)), reconsidered(daysAgo(35)),
            // Below the count gate but old enough for the time gate.
            entry(daysAgo(18))
        ]);
        const scan = scanSelfImprove(tmpRoot, NOW);
        expect(scan.owedSkills).toBe(1);
        expect(Math.floor(scan.maxAgeDays)).toBe(18);
    });

    it('does NOT count a skill below both gates (few recent entries)', () => {
        writeHistory('avi-foo', [entry(daysAgo(2)), entry(daysAgo(1))]);
        const scan = scanSelfImprove(tmpRoot, NOW);
        expect(scan.owedSkills).toBe(0);
    });

    it('reports max age across multiple owed skills', () => {
        writeHistory('avi-foo', [entry(daysAgo(16))]);
        writeHistory('avi-bar', [entry(daysAgo(25))]);
        const scan = scanSelfImprove(tmpRoot, NOW);
        expect(scan.owedSkills).toBe(2);
        expect(Math.floor(scan.maxAgeDays)).toBe(25);
    });

    it('does not treat a pending-recommendation skill as owed by default', () => {
        // A recommendation already exists; no fresh entries → not owed, but pending.
        writeHistory('avi-foo', [
            entry(daysAgo(40)), reconsidered(daysAgo(35)),
            JSON.stringify({ kind: 'recommendation', id: 'r1', total: 0.7, ts: daysAgo(35) })
        ]);
        const scan = scanSelfImprove(tmpRoot, NOW);
        expect(scan.pending).toBe(1);
        expect(scan.owedSkills).toBe(0);
    });

    it('does NOT count an old reconsider marker with zero new entries (no empty-nag)', () => {
        // The time gate requires >= 1 new entry. An ancient reconsidered marker
        // alone, with nothing captured since, must not flag the skill as owed.
        writeHistory('avi-foo', [
            entry(daysAgo(60)), reconsidered(daysAgo(45))
        ]);
        const scan = scanSelfImprove(tmpRoot, NOW);
        expect(scan.owedSkills).toBe(0);
        expect(scan.maxAgeDays).toBe(0);
    });
});

describe('PendingSelfImproveWidget — overdue render', () => {
    const item: WidgetItem = { id: 'p', type: 'pending-self-improve' };
    const labeledItem: WidgetItem = { id: 'p', type: 'pending-self-improve', metadata: { label: 'self-improve' } };
    const rawItem: WidgetItem = { id: 'p', type: 'pending-self-improve', rawValue: true };
    const hideItem: WidgetItem = { id: 'p', type: 'pending-self-improve', metadata: { hideWhenEmpty: 'true' } };
    const context: RenderContext = {};

    // 6 entries dated ~now (count gate fires immediately regardless of wall clock).
    function writeOwed(): void {
        const recent = new Date().toISOString();
        writeHistory('avi-foo', Array.from({ length: 6 }, (_, i) => JSON.stringify({ kind: 'entry', id: `e${i}`, skill: 'avi-foo', ts: recent, trigger: 'x' })));
    }

    it('renders the overdue glyph + counts when zero pending but a gate fired', () => {
        writeOwed();
        const widget = new PendingSelfImproveWidget(tmpRoot);
        const out = widget.render(item, context, DEFAULT_SETTINGS);
        expect(out).toMatch(/^📝 ⏳ 1 \/ \d+d$/);
    });

    it('renders overdue with a label instead of the emoji', () => {
        writeOwed();
        const widget = new PendingSelfImproveWidget(tmpRoot);
        const out = widget.render(labeledItem, context, DEFAULT_SETTINGS);
        expect(out).toMatch(/^self-improve ⏳ 1 \/ \d+d$/);
    });

    it('renders overdue body without glyph/label in raw mode', () => {
        writeOwed();
        const widget = new PendingSelfImproveWidget(tmpRoot);
        const out = widget.render(rawItem, context, DEFAULT_SETTINGS);
        expect(out).toMatch(/^⏳ 1 \/ \d+d$/);
    });

    it('still shows overdue even when hide-when-empty is set (owed is not empty)', () => {
        writeOwed();
        const widget = new PendingSelfImproveWidget(tmpRoot);
        const out = widget.render(hideItem, context, DEFAULT_SETTINGS);
        expect(out).toMatch(/^📝 ⏳ 1 \/ \d+d$/);
    });

    it('pending count takes precedence over overdue', () => {
        // Owed AND has a pending recommendation → show the pending number, not the glyph.
        const recent = new Date().toISOString();
        writeHistory('avi-foo', [
            ...Array.from({ length: 6 }, (_, i) => JSON.stringify({ kind: 'entry', id: `e${i}`, skill: 'avi-foo', ts: recent, trigger: 'x' })),
            JSON.stringify({ kind: 'recommendation', id: 'r1', total: 0.7, ts: recent })
        ]);
        const widget = new PendingSelfImproveWidget(tmpRoot);
        expect(widget.render(item, context, DEFAULT_SETTINGS)).toBe('📝 1');
    });
});

describe('PendingSelfImproveWidget', () => {
    const item: WidgetItem = { id: 'p', type: 'pending-self-improve' };
    const rawItem: WidgetItem = { id: 'p', type: 'pending-self-improve', rawValue: true };
    const hideItem: WidgetItem = {
        id: 'p',
        type: 'pending-self-improve',
        metadata: { hideWhenEmpty: 'true' }
    };
    const context: RenderContext = {};

    it('has correct metadata', () => {
        const widget = new PendingSelfImproveWidget(tmpRoot);
        expect(widget.getDisplayName()).toBe('Pending Self-Improve');
        expect(widget.getCategory()).toBe('Session');
        expect(widget.getDefaultColor()).toBe('yellow');
        expect(widget.supportsRawValue()).toBe(true);
        expect(widget.supportsColors(item)).toBe(true);
    });

    it('returns preview text in preview mode (with glyph)', () => {
        const widget = new PendingSelfImproveWidget(tmpRoot);
        expect(widget.render(item, { isPreview: true }, DEFAULT_SETTINGS)).toBe('📝 3');
    });

    it('returns preview text in preview mode (raw)', () => {
        const widget = new PendingSelfImproveWidget(tmpRoot);
        expect(widget.render(rawItem, { isPreview: true }, DEFAULT_SETTINGS)).toBe('3');
    });

    it('renders count with glyph when pending > 0', () => {
        writeHistory('avi-foo', [
            JSON.stringify({ kind: 'recommendation', id: 'r1', total: 0.7 }),
            JSON.stringify({ kind: 'recommendation', id: 'r2', total: 0.5 })
        ]);
        const widget = new PendingSelfImproveWidget(tmpRoot);
        expect(widget.render(item, context, DEFAULT_SETTINGS)).toBe('📝 2');
    });

    it('renders raw count without glyph', () => {
        writeHistory('avi-foo', [
            JSON.stringify({ kind: 'recommendation', id: 'r1', total: 0.7 })
        ]);
        const widget = new PendingSelfImproveWidget(tmpRoot);
        expect(widget.render(rawItem, context, DEFAULT_SETTINGS)).toBe('1');
    });

    it('renders "📝 0" when count is 0 and hide flag is off', () => {
        const widget = new PendingSelfImproveWidget(tmpRoot);
        expect(widget.render(item, context, DEFAULT_SETTINGS)).toBe('📝 0');
    });

    it('returns null when count is 0 and hide-when-empty is on', () => {
        const widget = new PendingSelfImproveWidget(tmpRoot);
        expect(widget.render(hideItem, context, DEFAULT_SETTINGS)).toBeNull();
    });

    it('still renders when count > 0 even with hide-when-empty on', () => {
        writeHistory('avi-foo', [
            JSON.stringify({ kind: 'recommendation', id: 'r1', total: 0.7 })
        ]);
        const widget = new PendingSelfImproveWidget(tmpRoot);
        expect(widget.render(hideItem, context, DEFAULT_SETTINGS)).toBe('📝 1');
    });

    it('toggles hide-when-empty metadata', () => {
        const widget = new PendingSelfImproveWidget(tmpRoot);
        const base: WidgetItem = { id: 'p', type: 'pending-self-improve' };
        const hidden = widget.handleEditorAction('toggle-hide-empty', base);
        expect(hidden?.metadata?.hideWhenEmpty).toBe('true');
        if (!hidden) {
            throw new Error('expected handleEditorAction to return a toggled item');
        }
        const shown = widget.handleEditorAction('toggle-hide-empty', hidden);
        expect(shown?.metadata?.hideWhenEmpty).toBe('false');
    });

    it('returns null for unknown editor actions', () => {
        const widget = new PendingSelfImproveWidget(tmpRoot);
        expect(widget.handleEditorAction('unknown', item)).toBeNull();
    });

    it('exposes numeric value for status-line consumers', () => {
        writeHistory('avi-foo', [
            JSON.stringify({ kind: 'recommendation', id: 'r1', total: 0.7 }),
            JSON.stringify({ kind: 'recommendation', id: 'r2', total: 0.5 })
        ]);
        const widget = new PendingSelfImproveWidget(tmpRoot);
        expect(widget.getNumericValue(context, item)).toBe(2);
    });

    it('editor display shows hide-when-empty modifier when enabled', () => {
        const widget = new PendingSelfImproveWidget(tmpRoot);
        expect(widget.getEditorDisplay(item).modifierText).toBeUndefined();
        expect(widget.getEditorDisplay(hideItem).modifierText).toBe('(hide when empty)');
    });

    it('label metadata replaces emoji in render output', () => {
        writeHistory('avi-foo', [
            JSON.stringify({ kind: 'recommendation', id: 'r1', total: 0.7 }),
            JSON.stringify({ kind: 'recommendation', id: 'r2', total: 0.5 })
        ]);
        const widget = new PendingSelfImproveWidget(tmpRoot);
        const labeledItem: WidgetItem = {
            id: 'p',
            type: 'pending-self-improve',
            metadata: { label: 'self-improve' }
        };
        expect(widget.render(labeledItem, context, DEFAULT_SETTINGS)).toBe('self-improve 2');
    });

    it('label metadata renders zero count with label when not hidden', () => {
        const widget = new PendingSelfImproveWidget(tmpRoot);
        const labeledItem: WidgetItem = {
            id: 'p',
            type: 'pending-self-improve',
            metadata: { label: 'pending' }
        };
        expect(widget.render(labeledItem, context, DEFAULT_SETTINGS)).toBe('pending 0');
    });

    it('label metadata in preview mode replaces emoji', () => {
        const widget = new PendingSelfImproveWidget(tmpRoot);
        const labeledItem: WidgetItem = {
            id: 'p',
            type: 'pending-self-improve',
            metadata: { label: 'SI' }
        };
        expect(widget.render(labeledItem, { isPreview: true }, DEFAULT_SETTINGS)).toBe('SI 3');
    });

    it('label metadata combined with rawValue still emits bare count', () => {
        writeHistory('avi-foo', [
            JSON.stringify({ kind: 'recommendation', id: 'r1', total: 0.7 })
        ]);
        const widget = new PendingSelfImproveWidget(tmpRoot);
        const labeledRawItem: WidgetItem = {
            id: 'p',
            type: 'pending-self-improve',
            rawValue: true,
            metadata: { label: 'self-improve' }
        };
        expect(widget.render(labeledRawItem, context, DEFAULT_SETTINGS)).toBe('1');
    });

    it('empty-string label falls back to emoji render (treated as not set)', () => {
        writeHistory('avi-foo', [
            JSON.stringify({ kind: 'recommendation', id: 'r1', total: 0.7 })
        ]);
        const widget = new PendingSelfImproveWidget(tmpRoot);
        const emptyLabelItem: WidgetItem = {
            id: 'p',
            type: 'pending-self-improve',
            metadata: { label: '' }
        };
        expect(widget.render(emptyLabelItem, context, DEFAULT_SETTINGS)).toBe('📝 1');
    });

    it('editor display surfaces configured label as modifier', () => {
        const widget = new PendingSelfImproveWidget(tmpRoot);
        const labeledItem: WidgetItem = {
            id: 'p',
            type: 'pending-self-improve',
            metadata: { label: 'self-improve' }
        };
        expect(widget.getEditorDisplay(labeledItem).modifierText).toBe('(label: self-improve)');
    });

    it('editor display combines hide-when-empty and label modifiers', () => {
        const widget = new PendingSelfImproveWidget(tmpRoot);
        const bothItem: WidgetItem = {
            id: 'p',
            type: 'pending-self-improve',
            metadata: { hideWhenEmpty: 'true', label: 'pending' }
        };
        expect(widget.getEditorDisplay(bothItem).modifierText).toBe('(hide when empty, label: pending)');
    });
});