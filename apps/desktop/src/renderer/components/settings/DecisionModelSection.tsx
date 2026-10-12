/**
 * Settings → 判断模型 → 本机 Laya 路由。
 *
 * 首版只配置本机 Laya 路由，不把 Laya 注册成第四个 Agent。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { checkDecisionModelEndpoint } from '@/lib/decisionModelClient';
import {
  resetDecisionModelSettings,
  updateDecisionModelSettings,
  useDecisionModelSettings,
} from '@/state/decisionModelSettings';
import { SettingsTextInput } from './SettingsTextInput';

const CARD_CLASS = cn(
  'flex flex-col rounded-xl',
  'bg-[var(--settings-theme-card-bg)]',
  'border border-[var(--settings-theme-card-border)]',
);
const ROW_CLASS = 'flex items-center justify-between gap-3 px-4 py-4';
const ROW_LABEL_CLASS = 'text-13 font-medium text-[var(--settings-section-sublabel)]';
const ROW_HINT_CLASS =
  'text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70';
const DIVIDER_CLASS = 'mx-4 h-px bg-[var(--settings-theme-card-border)]';

export function DecisionModelSection() {
  const { t } = useTranslation();
  const settings = useDecisionModelSettings();
  const [endpointDraft, setEndpointDraft] = useState(settings.endpoint);
  const [confidenceDraft, setConfidenceDraft] = useState(
    String(Math.round(settings.minConfidence * 100)),
  );
  const [testing, setTesting] = useState(false);

  const saveEndpoint = () => {
    const endpoint = endpointDraft.trim();
    if (!endpoint) {
      setEndpointDraft(settings.endpoint);
      return;
    }
    try {
      new URL(endpoint);
    } catch {
      toast.error(t('settings.decisionModel.invalidEndpoint'));
      setEndpointDraft(settings.endpoint);
      return;
    }
    updateDecisionModelSettings({ endpoint });
  };

  const saveConfidence = () => {
    const value = Number(confidenceDraft);
    if (!Number.isFinite(value)) {
      setConfidenceDraft(String(Math.round(settings.minConfidence * 100)));
      return;
    }
    const percent = Math.min(95, Math.max(30, Math.round(value)));
    setConfidenceDraft(String(percent));
    updateDecisionModelSettings({ minConfidence: percent / 100 });
  };

  const testConnection = async () => {
    setTesting(true);
    try {
      await checkDecisionModelEndpoint(settings.endpoint);
      toast.success(t('settings.decisionModel.connected'));
    } catch {
      toast.error(t('settings.decisionModel.connectionFailed'));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex min-h-[30px] items-center justify-between gap-3">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.decisionModel.title')}
        </h2>
        <button
          type="button"
          disabled={testing}
          onClick={() => {
            const next = resetDecisionModelSettings();
            setEndpointDraft(next.endpoint);
            setConfidenceDraft(String(Math.round(next.minConfidence * 100)));
          }}
          className="h-8 rounded-full px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
        >
          {t('settings.defaults.restore')}
        </button>
      </div>
      <p className="text-12 leading-[1.45] text-[var(--settings-section-desc)]">
        {t('settings.decisionModel.description')}
      </p>

      <div className={CARD_CLASS}>
        <div className={ROW_CLASS}>
          <span className="flex min-w-0 flex-col gap-1">
            <span className={ROW_LABEL_CLASS}>{t('settings.decisionModel.enabled')}</span>
            <span className={ROW_HINT_CLASS}>
              {t('settings.decisionModel.enabledHint')}
            </span>
          </span>
          <Switch
            checked={settings.enabled}
            onCheckedChange={(enabled) => updateDecisionModelSettings({ enabled })}
            aria-label={t('settings.decisionModel.enabled')}
          />
        </div>

        <div className={DIVIDER_CLASS} />

        <label className={ROW_CLASS}>
          <span className="flex min-w-0 flex-col gap-1">
            <span className={ROW_LABEL_CLASS}>{t('settings.decisionModel.endpoint')}</span>
            <span className={ROW_HINT_CLASS}>{t('settings.decisionModel.endpointHint')}</span>
          </span>
          <SettingsTextInput
            value={endpointDraft}
            onChange={setEndpointDraft}
            onBlur={saveEndpoint}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                saveEndpoint();
              }
            }}
            size="md"
            className="w-[min(360px,48%)] shrink-0"
          />
        </label>

        <div className={DIVIDER_CLASS} />

        <label className={ROW_CLASS}>
          <span className="flex min-w-0 flex-col gap-1">
            <span className={ROW_LABEL_CLASS}>{t('settings.decisionModel.confidence')}</span>
            <span className={ROW_HINT_CLASS}>{t('settings.decisionModel.confidenceHint')}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <SettingsTextInput
              type="number"
              min={30}
              max={95}
              value={confidenceDraft}
              onChange={setConfidenceDraft}
              onBlur={saveConfidence}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  saveConfidence();
                }
              }}
              size="md"
              className="w-20"
            />
            <span className="text-12 text-[var(--text-tertiary)]">%</span>
          </span>
        </label>

        <div className="flex items-center justify-between gap-3 border-t border-[var(--settings-theme-card-border)] px-4 py-3">
          <span className={ROW_HINT_CLASS}>{t('settings.decisionModel.scope')}</span>
          <button
            type="button"
            disabled={testing}
            onClick={() => void testConnection()}
            className="h-8 rounded-full border border-[var(--settings-btn-secondary-border)] px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
          >
            {testing
              ? t('settings.decisionModel.testing')
              : t('settings.decisionModel.testConnection')}
          </button>
        </div>
      </div>
    </div>
  );
}
