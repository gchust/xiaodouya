import { t } from '../i18n';
import type { EventData } from '../schemas';
import { vaccineRecordName } from './vaccines';

/**
 * 删除或移除已保存的内容之前要确认的东西。没保存的草稿（弹层里刚选的照片、没发出的反馈附件）
 * 不在这里：它们不算删除已保存的数据，多一步只会拖慢操作。
 */
export type DeleteTarget =
  /** `summary` 由界面按用户的单位和时间写好（比如 `喂奶 90ml · 11月5日 09:30`），这里不猜单位。 */
  | { kind: 'event'; event: EventData; summary: string }
  | { kind: 'moment'; title: string }
  | { kind: 'letter'; title: string }
  | { kind: 'document'; name: string }
  | { kind: 'documentFile'; name: string }
  | { kind: 'formula'; name: string }
  | { kind: 'vaccinePlan'; name: string }
  /** `summary` 由界面按币种写好（`压岁钱 · 爷爷 · ¥600`）。 */
  | { kind: 'money'; summary: string }
  | { kind: 'member'; name: string };

export interface DeleteConfirmText {
  /** 弹层标题，是一句问句，写清楚删的是什么。 */
  title: string;
  body: string;
  /** 危险色按钮上的字。 */
  confirm: string;
}

/** 确认弹层的文字。必须在函数里取 `t()`，语言定好之前求值的文字不会再变。 */
export function deleteConfirmText(target: DeleteTarget): DeleteConfirmText {
  const text = t().confirm;
  const deleting = (title: string, body: string): DeleteConfirmText => ({
    title,
    body: `${body}${text.undoHint}`,
    confirm: text.delete,
  });
  const removing = (title: string, body: string): DeleteConfirmText => ({
    title,
    body: `${body}${text.removeUndoHint}`,
    confirm: text.remove,
  });
  switch (target.kind) {
    case 'event': {
      const { event } = target;
      const title =
        event.type === 'vaccine'
          ? text.vaccine(vaccineRecordName(event.vaccineId, event.name))
          : text.event[event.type];
      const body = `${text.eventBody}${text.undoHint}`;
      return {
        title,
        body: target.summary ? `${target.summary}\n${body}` : body,
        confirm: text.delete,
      };
    }
    case 'moment':
      return deleting(target.title ? text.momentNamed(target.title) : text.moment, text.momentBody);
    case 'letter':
      return deleting(target.title ? text.letterNamed(target.title) : text.letter, text.letterBody);
    case 'document':
      return deleting(text.document(target.name), text.documentBody);
    case 'documentFile':
      return removing(text.documentFile(target.name), text.documentFileBody);
    case 'formula':
      return deleting(text.formula(target.name), text.formulaBody);
    case 'vaccinePlan':
      return removing(text.vaccinePlan(target.name), text.vaccinePlanBody);
    case 'money':
      return {
        title: text.money,
        body: `${target.summary}\n${text.moneyBody}${text.undoHint}`,
        confirm: text.delete,
      };
    case 'member':
      // 移出家庭在服务端立刻生效，没有撤销，所以不提撤销。
      return {
        title: text.member(target.name),
        body: text.memberBody(target.name),
        confirm: text.removeMember,
      };
  }
}
