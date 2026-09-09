import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function readSidebarSource(...parts: string[]) {
  return readFileSync(
    resolve(__dirname, '..', 'features', 'cc-agent', 'sidebar', ...parts),
    'utf8',
  );
}

const sessionEntryListSource = readSidebarSource('SessionEntryList.tsx');
const projectNodeSource = readSidebarSource('sections', 'ProjectNode.tsx');
const projectsSectionSource = readSidebarSource('sections', 'ProjectsSection.tsx');
const dialogueSectionSource = readSidebarSource('sections', 'DialogueSection.tsx');
const sectionCollapseSource = readSidebarSource('SectionCollapse.tsx');

describe('sidebar collapse reset wiring', () => {
  it('resets the collapsible session list showAll from its parent section collapsed state', () => {
    expect(sessionEntryListSource).toContain('sectionCollapsed?: boolean');
    expect(sessionEntryListSource).toContain('useCollapsibleShowAll(sectionCollapsed)');
  });

  it('resets project session showAll only when the parent section collapses', () => {
    expect(projectNodeSource).toContain('parentSectionCollapsed: boolean');
    expect(projectNodeSource).toContain('sectionCollapsed={parentSectionCollapsed}');
    // 2026-09-03 定稿:项目自身折叠不再复位「显示全部」;只有父级区域折叠才复位,
    // 批量收进项目文件夹后展开仍保持用户之前的展开状态。
    expect(projectsSectionSource).toContain('parentSectionCollapsed={false}');
    // 项目 / 对话组内的「显示全部」由 ProjectsSection 按 key 保存,跨卸载恢复。
    expect(projectsSectionSource).toContain('sessionShowAllKeys');
    expect(projectsSectionSource).toContain('showAll={sessionShowAllKeys.has(');
    expect(projectsSectionSource).toContain('onShowAllChange={(next) => setSessionShowAll(');
  });

  it('passes the Dialogue section collapsed state into its collapsible session list', () => {
    expect(dialogueSectionSource).toContain('sectionCollapsed={collapsed}');
    // 对话组头自身折叠不再复位组内「显示全部」(与项目文件夹同一语义)。
    expect(projectsSectionSource).toContain('sectionCollapsed={parentSectionCollapsed}');
  });

  it('Projects section project-list showAll no longer tracks a section collapse (removed)', () => {
    // 段级收起已取消(2026-08-13 定稿),showAll 不再有段收起复位来源。
    expect(projectsSectionSource).toContain('useCollapsibleShowAll(false)');
  });

  it('keeps the reset delay constant in sync with the CSS animation duration', () => {
    // Tailwind 任意值类名无法引用常量,两处 200 只能靠这条断言互锁:
    // 谁改了动画时长却没同步另一处,这里立刻红。
    expect(sectionCollapseSource).toContain('SECTION_COLLAPSE_DURATION_MS = 200');
    expect(sectionCollapseSource).toContain('duration-[200ms]');
    expect(sectionCollapseSource).not.toMatch(/duration-\[(?!200ms)\d+m?s\]/);
  });
});
