/**
 * menuStyles —— sidebar 点击弹出框(DropdownMenu / 右键菜单)的统一视觉常量。
 * ---------------------------------------------------------------------------
 * 混合版同时保留本地侧栏菜单常量与上游共享组件的默认视觉。常量不带宽度，
 * 调用方按需通过 cn(MENU_*_CLASS, 'w-*') 组合。
 */

/** 菜单 surface：兼容本地侧栏菜单的旧定制。 */
export const MENU_CONTENT_CLASS =
  'rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-1 text-[var(--cmd-palette-item-text)] shadow-[var(--shadow-menu)]';

/** 子菜单 surface 与主菜单保持一致。 */
export const MENU_SUB_CONTENT_CLASS = MENU_CONTENT_CLASS;

/** 普通菜单项。 */
export const MENU_ITEM_CLASS =
  'flex h-8 cursor-pointer select-none items-center gap-2 rounded-lg px-2 text-sm outline-none text-[var(--cmd-palette-item-text)] transition-colors focus:bg-[var(--cmd-palette-item-hover)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50';

/** 危险菜单项。 */
export const MENU_ITEM_DANGER_CLASS =
  'flex h-8 cursor-pointer select-none items-center gap-2 rounded-lg px-2 text-sm outline-none text-[hsl(var(--destructive))] transition-colors hover:bg-[hsl(var(--destructive))] hover:text-white focus:bg-[hsl(var(--destructive))] focus:text-white data-[disabled]:pointer-events-none data-[disabled]:opacity-50';

/** 含子菜单的触发行。 */
export const MENU_ROW_CLASS =
  'flex h-8 cursor-pointer select-none items-center gap-2 rounded-lg px-2 text-sm outline-none text-[var(--cmd-palette-item-text)] transition-colors focus:bg-[var(--cmd-palette-item-hover)] data-[state=open]:bg-[var(--cmd-palette-item-hover)]';

/** 菜单分隔线。 */
export const MENU_SEPARATOR_CLASS = 'my-1 h-px bg-[var(--cmd-palette-border)]';
