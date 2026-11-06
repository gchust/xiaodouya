import { describe, expect, it } from 'vitest';
import {
  canEditDocument,
  canReadMediaScope,
  canReadOwnedMedia,
  canSeeOwnedRecord,
  canWriteDocument,
  DocumentData,
  documentKind,
  documentReaderChoices,
  effectiveReaders,
  type FamilyMember,
  isAllowedMime,
  MAX_DOCUMENT_READERS,
  mediaCategory,
  rawDocumentOwner,
  thumbnailSize,
} from '../src';

const me = '00000000-0000-4000-8000-000000000001';
const mom = '00000000-0000-4000-8000-000000000002';
const aunt = '00000000-0000-4000-8000-000000000003';
const grandpa = '00000000-0000-4000-8000-000000000004';

const members: FamilyMember[] = [
  { userId: me, label: '爸爸', role: 'admin', lastSeenAt: null },
  { userId: mom, label: '妈妈', role: 'caregiver', lastSeenAt: null },
  { userId: aunt, label: '阿姨', role: 'caregiver', lastSeenAt: null },
  { userId: grandpa, label: '外公', role: 'viewer', lastSeenAt: null },
];

describe('证件的数据', () => {
  it('没有 owner 的是宝宝的证件，旧数据照样通过', () => {
    const parsed = DocumentData.parse({ name: '护照', files: [] });
    expect(parsed.owner).toBeUndefined();
    expect(documentKind(parsed, me)).toBe('family');
  });

  it('owner 格式不对整条不收，不能当成全家的证件显示', () => {
    expect(DocumentData.safeParse({ name: '身份证', files: [], owner: 'nobody' }).success).toBe(
      false,
    );
  });

  it('sharedWith 格式不对只丢这一项，结果是谁都不给看', () => {
    const parsed = DocumentData.parse({
      name: '身份证',
      files: [],
      owner: me,
      sharedWith: ['not-a-uuid'],
    });
    expect(parsed.owner).toBe(me);
    expect(parsed.sharedWith).toBeUndefined();
  });

  it('能看的人有上限', () => {
    const many = Array.from(
      { length: MAX_DOCUMENT_READERS + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const parsed = DocumentData.parse({ name: '身份证', files: [], owner: me, sharedWith: many });
    expect(parsed.sharedWith).toBeUndefined();
  });

  it('自己的、别人给我看的分得清，只有自己的和宝宝的能改', () => {
    expect(documentKind({ owner: me }, me)).toBe('mine');
    expect(documentKind({ owner: mom }, me)).toBe('shared');
    expect(canEditDocument({ owner: me }, me)).toBe(true);
    expect(canEditDocument({}, me)).toBe(true);
    expect(canEditDocument({ owner: mom }, me)).toBe(false);
  });
});

describe('从原始数据读 owner（删除时服务端不校验内容）', () => {
  it('没有字段、不是对象都是宝宝的', () => {
    expect(rawDocumentOwner({ name: 'x' })).toEqual({ ok: true, owner: null });
    expect(rawDocumentOwner(null)).toEqual({ ok: true, owner: null });
    expect(rawDocumentOwner('x')).toEqual({ ok: true, owner: null });
    expect(rawDocumentOwner({ owner: undefined })).toEqual({ ok: true, owner: null });
  });
  it('是 UUID 就是它，不是就不收', () => {
    expect(rawDocumentOwner({ owner: me })).toEqual({ ok: true, owner: me });
    expect(rawDocumentOwner({ owner: '' })).toEqual({ ok: false });
    expect(rawDocumentOwner({ owner: null })).toEqual({ ok: false });
    expect(rawDocumentOwner({ owner: 42 })).toEqual({ ok: false });
  });
});

describe('谁能写', () => {
  it('新建：只能建自己的，或者宝宝的', () => {
    expect(canWriteDocument(undefined, me, me)).toBe(true);
    expect(canWriteDocument(undefined, null, me)).toBe(true);
    expect(canWriteDocument(undefined, mom, me)).toBe(false);
  });
  it('宝宝的证件不能变成谁的私人证件', () => {
    expect(canWriteDocument(null, null, me)).toBe(true);
    expect(canWriteDocument(null, me, me)).toBe(false);
  });
  it('私人证件只有本人能写，owner 不能改也不能去掉', () => {
    expect(canWriteDocument(me, me, me)).toBe(true);
    expect(canWriteDocument(mom, mom, me)).toBe(false);
    expect(canWriteDocument(me, null, me)).toBe(false);
    expect(canWriteDocument(me, mom, me)).toBe(false);
  });
});

describe('谁能看到私人证件的内容', () => {
  const doc = { ownerId: mom, readers: [me], deleted: false };
  it('宝宝的证件不受影响', () => {
    expect(
      canSeeOwnedRecord(
        { ownerId: null, readers: null, deleted: false },
        { userId: me, role: 'caregiver' },
        true,
      ),
    ).toBe(true);
  });
  it('本人能看，删掉的也能（撤销要用）', () => {
    expect(
      canSeeOwnedRecord({ ...doc, deleted: true }, { userId: mom, role: 'caregiver' }, true),
    ).toBe(true);
  });
  it('被选中的家人能看；没选中的不能', () => {
    expect(canSeeOwnedRecord(doc, { userId: me, role: 'admin' }, true)).toBe(true);
    expect(canSeeOwnedRecord(doc, { userId: aunt, role: 'admin' }, true)).toBe(false);
  });
  it('删掉之后、本人离开家庭之后，别人都看不到', () => {
    expect(canSeeOwnedRecord({ ...doc, deleted: true }, { userId: me, role: 'admin' }, true)).toBe(
      false,
    );
    expect(canSeeOwnedRecord(doc, { userId: me, role: 'admin' }, false)).toBe(false);
  });
  it('只看回忆的家人就算被选中也看不到', () => {
    expect(
      canSeeOwnedRecord({ ...doc, readers: [grandpa] }, { userId: grandpa, role: 'viewer' }, true),
    ).toBe(false);
  });
});

describe('私人证件的文件', () => {
  const ref = (ownerId: string | null, readers: string[], extra = {}) => ({
    ownerId,
    readers,
    deleted: false,
    ownerIsMember: true,
    ...extra,
  });
  const personal = { scope: 'personal' as const, ownerId: mom, uploadedBy: mom };

  it('本人能取；被选中的家人要有一条本人的证件引用它', () => {
    expect(canReadOwnedMedia(personal, [], { userId: mom, role: 'caregiver' })).toBe(true);
    expect(canReadOwnedMedia(personal, [], { userId: me, role: 'admin' })).toBe(false);
    expect(canReadOwnedMedia(personal, [ref(mom, [me])], { userId: me, role: 'admin' })).toBe(true);
    expect(canReadOwnedMedia(personal, [ref(mom, [aunt])], { userId: me, role: 'admin' })).toBe(
      false,
    );
  });

  it('别人把文件 id 写进自己的证件再分享，拿不到', () => {
    expect(canReadOwnedMedia(personal, [ref(aunt, [me])], { userId: me, role: 'admin' })).toBe(
      false,
    );
  });

  it('撤销、删除、本人离开家庭后拿不到', () => {
    expect(
      canReadOwnedMedia(personal, [ref(mom, [me], { deleted: true })], {
        userId: me,
        role: 'admin',
      }),
    ).toBe(false);
    expect(
      canReadOwnedMedia(personal, [ref(mom, [me], { ownerIsMember: false })], {
        userId: me,
        role: 'admin',
      }),
    ).toBe(false);
  });

  it('只看回忆的家人谁的证件文件都拿不到', () => {
    expect(
      canReadOwnedMedia(personal, [ref(mom, [grandpa])], { userId: grandpa, role: 'viewer' }),
    ).toBe(false);
    expect(canReadMediaScope('viewer', 'personal')).toBe(false);
  });

  it('旧版 App 往私人证件里加的 document 文件按私人证件处理；没人引用的还是宝宝的', () => {
    const legacy = { scope: 'document' as const, ownerId: null, uploadedBy: mom };
    expect(canReadOwnedMedia(legacy, [], { userId: aunt, role: 'caregiver' })).toBe(true);
    expect(canReadOwnedMedia(legacy, [ref(mom, [me])], { userId: aunt, role: 'caregiver' })).toBe(
      false,
    );
    expect(canReadOwnedMedia(legacy, [ref(mom, [me])], { userId: me, role: 'admin' })).toBe(true);
  });

  it('别人把宝宝证件的文件写进自己的私人证件，不能让全家看不到', () => {
    const baby = { scope: 'document' as const, ownerId: null, uploadedBy: me };
    expect(canReadOwnedMedia(baby, [ref(aunt, [])], { userId: mom, role: 'caregiver' })).toBe(true);
  });

  it('回忆和头像不受影响', () => {
    expect(
      canReadOwnedMedia({ scope: 'memory', ownerId: null, uploadedBy: mom }, [ref(mom, [])], {
        userId: aunt,
        role: 'caregiver',
      }),
    ).toBe(true);
  });

  it('上传白名单、用量分类、缩略图大小和宝宝的证件一样', () => {
    expect(isAllowedMime('application/pdf', 'personal')).toBe(true);
    expect(isAllowedMime('video/mp4', 'personal')).toBe(false);
    expect(mediaCategory('image/jpeg', 'personal')).toBe('document');
    expect(thumbnailSize('personal')).toEqual(thumbnailSize('document'));
  });
});

describe('谁能看的选择', () => {
  it('不含自己和只看回忆的家人', () => {
    expect(documentReaderChoices(members, me).map((m) => m.label)).toEqual(['妈妈', '阿姨']);
  });
  it('已经离开家庭、改成只看回忆的不算能看', () => {
    const gone = '00000000-0000-4000-8000-000000000009';
    expect(
      effectiveReaders({ sharedWith: [mom, gone, grandpa] }, members, me).map((m) => m.label),
    ).toEqual(['妈妈']);
  });
});
