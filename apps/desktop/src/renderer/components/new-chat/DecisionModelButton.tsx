import { useState } from 'react';
import { BrainCircuit, Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  updateDecisionModelSettings,
  useDecisionModelSettings,
} from '@/state/decisionModelSettings';

interface DecisionModelButtonProps {
  dense?: boolean;
  compact?: boolean;
  createAgent?: boolean;
}

/** 输入框内的本机判断模型入口：就地开关，完整参数仍放在设置页。 */
export function DecisionModelButton({
  dense = false,
  compact = false,
  createAgent = false,
}: DecisionModelButtonProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const settings = useDecisionModelSettings();
  const [open, setOpen] = useState(false);

  const openSettings = () => {
    setOpen(false);
    navigate('/settings?tab=decision-model');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('newChat.chatInput.decisionSettingsHint')}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={cn(
            'inline-flex h-[30px] shrink-0 items-center justify-center gap-1.5 rounded-full border border-transparent bg-transparent px-2.5 text-12 text-[var(--composer-pill-icon,#3C3F43)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] dark:text-[var(--composer-pill-icon,#D9D9D9)]',
            'hover:border-[var(--border-default)] hover:bg-[var(--composer-pill-bg,#FCFCFC)] dark:hover:bg-[var(--composer-pill-bg,#393838)]',
            'data-[state=open]:border-[var(--border-default)] data-[state=open]:bg-[var(--composer-pill-bg,#FCFCFC)] dark:data-[state=open]:bg-[var(--composer-pill-bg,#393838)]',
            dense && 'text-11',
            createAgent && 'h-[28px] px-2',
          )}
        >
          <BrainCircuit size={dense ? 13 : 14} aria-hidden="true" />
          {!compact && (
            <span className="whitespace-nowrap">{t('newChat.chatInput.decisionSettings')}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        className="w-[288px] rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-0 text-[var(--text-primary)] shadow-none"
      >
        <div className="flex items-start justify-between gap-3 px-4 py-4">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-13 font-medium text-[var(--settings-section-title)]">
              {t('settings.decisionModel.title')}
            </span>
            <span className="text-12 leading-[1.4] text-[var(--settings-section-desc)]">
              {t('settings.decisionModel.enabledHint')}
            </span>
          </div>
          <Switch
            checked={settings.enabled}
            onCheckedChange={(enabled) => updateDecisionModelSettings({ enabled })}
            aria-label={t('settings.decisionModel.enabled')}
          />
        </div>
        <div className="border-t border-[var(--settings-theme-card-border)] p-2">
          <button
            type="button"
            onClick={openSettings}
            className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-13 text-[var(--settings-section-sublabel)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            <Settings2 size={14} aria-hidden="true" />
            <span>{t('newChat.chatInput.decisionSettingsOpen')}</span>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
