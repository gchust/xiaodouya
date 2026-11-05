import { type DeleteConfirmText, type DeleteTarget, deleteConfirmText, t } from '@xiaodouya/shared';
import { useCallback, useState } from 'react';
import { useFeedback, useSheet } from './overlays';
import { Button, Muted } from './primitives';

/**
 * 删除已保存内容前的确认。取消放在最下面：弹层贴着底部，原来的删除按钮一般也在最下面，
 * 连点两下时第二下落在“取消”上，不会直接删掉。
 */
export function DeleteConfirm({
  text,
  onConfirm,
  onCancel,
  confirmTestID = 'delete-sheet-confirm',
}: {
  text: DeleteConfirmText;
  onConfirm: () => unknown;
  onCancel: () => void;
  confirmTestID?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Muted testID="delete-sheet-body" style={{ fontSize: 13, lineHeight: 21 }}>
        {text.body}
      </Muted>
      <Button
        testID={confirmTestID}
        tone="danger"
        label={text.confirm}
        busy={busy}
        onPress={() => {
          setBusy(true);
          void Promise.resolve(onConfirm()).finally(() => setBusy(false));
        }}
      />
      <Button
        testID="delete-sheet-cancel"
        tone="outline"
        label={t().common.cancel}
        disabled={busy}
        onPress={onCancel}
      />
    </>
  );
}

/**
 * 打开删除确认。已经开着的弹层（记录详情、回忆的 ⋯）直接换成确认，取消就关掉。
 * 只在按钮的点击里用：撤销、同步和 `app.remove` 本身都不经过这里。
 */
export function useDeleteConfirm() {
  const sheet = useSheet();
  const { dismissToast } = useFeedback();
  return useCallback(
    (target: DeleteTarget, onConfirm: () => unknown, options?: { confirmTestID?: string }) => {
      const text = deleteConfirmText(target);
      // `replace` 不会收起 Toast，而 Toast 正好盖住弹层底部的按钮。
      dismissToast();
      sheet.replace(text.title, () => (
        <DeleteConfirm
          text={text}
          onConfirm={onConfirm}
          onCancel={() => sheet.close()}
          confirmTestID={options?.confirmTestID}
        />
      ));
    },
    [sheet, dismissToast],
  );
}
