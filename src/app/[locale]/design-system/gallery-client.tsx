'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Dialog, DialogContent, DialogTrigger } from '@/shared/ui/dialog';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/form-controls';
import { useToast } from '@/shared/ui/toast';
import { windowIssues, type ScheduleWindow } from '@/modules/scheduling/schemas';
import { WindowsEditor } from '@/modules/scheduling/ui/windows-editor';

/** Interactive demos for the development gallery (no data access). */
export function DialogDemos() {
  const t = useTranslations();
  const toast = useToast();
  return (
    <div className="flex flex-wrap gap-2">
      <Dialog>
        <DialogTrigger asChild>
          <Button>{t('designSystem.openDialog')}</Button>
        </DialogTrigger>
        <DialogContent
          title={t('designSystem.openDialog')}
          description={t('designSystem.dialogBody')}
          closeLabel={t('common.close')}
          footer={<Button variant="primary">{t('designSystem.confirmSample')}</Button>}
        >
          <Field id="demo-field" label={t('patients.form.lastName')} required>
            <Input />
          </Field>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        tone="danger"
        trigger={<Button variant="danger-outline">{t('designSystem.openConfirm')}</Button>}
        title={t('reception.cancelTitle')}
        description={t('designSystem.dialogBody')}
        confirmLabel={t('reception.cancel')}
        cancelLabel={t('reception.cancelKeep')}
        onConfirm={async () => undefined}
      />
      <Button variant="ghost" onClick={() => toast({ tone: 'success', title: t('designSystem.toastSampleTitle') })}>
        {t('designSystem.toastSample')}
      </Button>
    </div>
  );
}

/**
 * Weekly hours editor (module 5) with live validation, so its layout, RTL behaviour and
 * accessibility can be checked without a backend. Nothing is saved.
 */
export function WindowsEditorDemo() {
  const [windows, setWindows] = useState<ScheduleWindow[]>([
    { weekday: 1, start: '08:30', end: '12:30' },
    { weekday: 1, start: '14:00', end: '18:00' },
    { weekday: 2, start: '08:30', end: '12:30' },
    { weekday: 2, start: '12:00', end: '13:00' },
    { weekday: 6, start: '09:00', end: '12:00' },
  ]);
  return <WindowsEditor idPrefix="ds-hours" value={windows} onChange={setWindows} issues={windowIssues(windows)} />;
}
