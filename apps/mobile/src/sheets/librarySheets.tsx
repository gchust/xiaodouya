import {
  createTapGuard,
  defaultResourceTitle,
  type FavoriteData,
  type FavoriteFolderData,
  type FavoriteTarget,
  favoriteIdFor,
  guardTap,
  mergeEdit,
  normalizeResourceUrl,
  parseSharedText,
  type ResourceData,
  resourceSource,
  resourceSourceLabel,
  TAP_HOLD_MS,
  t,
} from '@xiaodouya/shared';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useApp, useRecords } from '../lib/app';
import { openResourceUrl, useFavorites } from '../lib/library';
import { colors } from '../theme';
import { useDeleteConfirm } from '../ui/DeleteConfirm';
import { useFeedback, useSheet } from '../ui/overlays';
import { Button, Chip, Field, Muted } from '../ui/primitives';

type Sheet = ReturnType<typeof useSheet>;
type ResourceEntry = { id: string; data: ResourceData };

export function openResourceSheet(
  sheet: Sheet,
  options: { entry?: ResourceEntry; initial?: { url: string; title?: string } } = {},
) {
  sheet.open(options.entry ? t().library.editTitle : t().library.addTitle, () => (
    <ResourceSheet entry={options.entry} initial={options.initial} />
  ));
}

/**
 * 添加或修改一条资料。粘贴一整段分享文字也行：取出链接，标题预填成分享里的标题。
 * 只有链接是必填的，标题不填就用来源的默认标题。
 */
export function ResourceSheet({
  entry,
  initial,
}: {
  entry?: ResourceEntry;
  initial?: { url: string; title?: string };
}) {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const confirmDelete = useDeleteConfirm();
  const { resources } = useRecords();
  const guard = useRef(createTapGuard({ holdMs: TAP_HOLD_MS })).current;
  const existing = entry?.data;
  const [url, setUrl] = useState(existing?.url ?? initial?.url ?? '');
  const [title, setTitle] = useState(existing?.title ?? initial?.title ?? '');
  const [note, setNote] = useState(existing?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  // 只在点了“粘贴链接”时读剪贴板：Android 13 起读一次系统就提示一次，打开弹层就读会吓到人。
  const [clipboardHasText, setClipboardHasText] = useState(false);
  useEffect(() => {
    if (existing) return;
    let alive = true;
    void Clipboard.hasStringAsync()
      .then((has) => {
        if (alive) setClipboardHasText(has);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [existing]);

  const normalized = normalizeResourceUrl(url);
  const source = resourceSource(normalized ?? '');
  const fallbackTitle = defaultResourceTitle(source);

  /** 粘贴或输入一整段分享文字：链接放进链接框，标题没填过就预填。 */
  const takeText = (text: string) => {
    const shared = text.includes(' ') || text.includes('\n') ? parseSharedText(text) : null;
    if (shared) {
      setUrl(shared.url);
      if (!title.trim() && shared.title) setTitle(shared.title);
    } else {
      setUrl(text);
    }
    if (error) setError(null);
  };

  const paste = async () => {
    const text = await Clipboard.getStringAsync().catch(() => '');
    if (!normalizeResourceUrl(text)) {
      toast(t().library.noLinkInClipboard);
      return;
    }
    takeText(text.trim());
  };

  const save = async () => {
    if (!url.trim()) {
      setError(t().library.errors.emptyUrl);
      return;
    }
    if (!normalized) {
      setError(t().library.errors.invalidUrl);
      return;
    }
    const fields = {
      url: normalized,
      title: title.trim() || fallbackTitle,
      note: note.trim() || undefined,
    };
    const latest = entry ? resources.find((r) => r.id === entry.id)?.data : undefined;
    const data: ResourceData =
      entry && existing && latest
        ? mergeEdit(existing, latest, fields)
        : {
            type: 'resource',
            ...fields,
            addedAt: Date.now(),
            byName: app.label || undefined,
          };
    const saved = await guardTap(guard, 'save', Date.now, () =>
      app.write('event', data, entry?.id),
    );
    if (!saved.ran) return;
    const id = saved.value;
    sheet.close();
    toast(entry ? t().library.edited : t().library.saved(data.title), {
      undo: entry
        ? latest
          ? () => void app.write('event', latest, id)
          : undefined
        : () => void app.remove(id),
    });
  };

  const remove = async () => {
    if (!entry) return;
    const latest = resources.find((r) => r.id === entry.id)?.data ?? entry.data;
    await app.remove(entry.id);
    sheet.close();
    toast(t().library.deleted, { undo: () => void app.write('event', latest, entry.id) });
  };

  return (
    <>
      <View style={{ gap: 8 }}>
        <Field
          testID="resource-url"
          label={t().library.link}
          value={url}
          onChangeText={takeText}
          placeholder={t().library.linkPlaceholder}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          maxLength={4000}
        />
        {clipboardHasText ? (
          <View style={s.chips}>
            <Pressable
              testID="resource-paste"
              accessibilityRole="button"
              accessibilityLabel={t().library.pasteA11y}
              hitSlop={{ top: 7, bottom: 7, left: 4, right: 4 }}
              onPress={() => void paste()}
              style={s.paste}
            >
              <Text style={s.pasteLabel}>{t().library.paste}</Text>
            </Pressable>
          </View>
        ) : null}
        {normalized ? (
          <Muted testID="resource-source" style={{ fontSize: 12 }}>
            {resourceSourceLabel(source)}
          </Muted>
        ) : null}
        {error ? (
          <Text testID="resource-error" style={s.error}>
            {error}
          </Text>
        ) : null}
      </View>
      <Field
        testID="resource-title"
        label={t().library.titleLabel}
        value={title}
        onChangeText={setTitle}
        placeholder={t().library.titlePlaceholder(fallbackTitle)}
        maxLength={200}
      />
      <Field
        testID="resource-note"
        label={t().library.note}
        value={note}
        onChangeText={setNote}
        placeholder={t().library.notePlaceholder}
        multiline
        maxLength={2000}
      />
      <Muted style={{ fontSize: 11, lineHeight: 18 }}>{t().library.thirdParty}</Muted>
      <Button
        testID="resource-save"
        label={entry ? t().library.saveEdit : t().library.save}
        onPress={() => void save()}
      />
      {entry ? (
        <Button
          testID="resource-delete"
          tone="ghost"
          label={t().library.deleteResource}
          onPress={() => confirmDelete({ kind: 'resource', title: entry.data.title }, remove)}
        />
      ) : null}
    </>
  );
}

/** 资料的 ⋯：打开、修改、收藏、放进收藏夹、复制链接、删除。 */
export function ResourceActions({ entry }: { entry: ResourceEntry }) {
  const sheet = useSheet();
  const { toast } = useFeedback();
  const { find, toggle } = useFavorites();
  const confirmDelete = useDeleteConfirm();
  const app = useApp();
  const favorited = Boolean(find(entry.id));
  return (
    <>
      <Button
        testID="resource-open"
        tone="dark"
        label={t().library.open}
        onPress={() => {
          sheet.close();
          void openResourceUrl(entry.data.url, toast);
        }}
      />
      <Button
        testID="resource-edit"
        tone="outline"
        label={t().library.edit}
        onPress={() => sheet.replace(t().library.editTitle, () => <ResourceSheet entry={entry} />)}
      />
      <Button
        testID="resource-favorite"
        tone="outline"
        label={favorited ? t().library.unfavorite : t().library.favorite}
        onPress={() => {
          sheet.close();
          void toggle('resource', entry.id);
        }}
      />
      <Button
        testID="resource-folders"
        tone="outline"
        label={t().library.addToFolder}
        onPress={() =>
          sheet.replace(t().library.addToFolder, () => (
            <FolderPicker target="resource" targetId={entry.id} />
          ))
        }
      />
      <Button
        testID="resource-copy"
        tone="outline"
        label={t().library.copy}
        onPress={() => {
          void Clipboard.setStringAsync(entry.data.url).catch(() => {});
          sheet.close();
          toast(t().library.copied);
        }}
      />
      <Button
        testID="resource-delete"
        tone="ghost"
        label={t().library.deleteResource}
        onPress={() =>
          confirmDelete({ kind: 'resource', title: entry.data.title }, async () => {
            await app.remove(entry.id);
            sheet.close();
            toast(t().library.deleted, {
              undo: () => void app.write('event', entry.data, entry.id),
            });
          })
        }
      />
    </>
  );
}

/**
 * 放进收藏夹：每个收藏夹一行，点一下放进或拿出，可以放进几个。下面可以直接新建一个，建好就选上。
 * 保存时才写入；放进任何一个收藏夹也就收藏了。
 */
export function FolderPicker({ target, targetId }: { target: FavoriteTarget; targetId: string }) {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const { favoriteFolders } = useRecords();
  const { find } = useFavorites();
  const current = find(targetId);
  const [chosen, setChosen] = useState<string[]>(() => current?.data.folders ?? []);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t().library.folderErrors.empty);
      return;
    }
    if (favoriteFolders.some((f) => f.data.name === trimmed)) {
      setError(t().library.folderErrors.duplicate);
      return;
    }
    const data: FavoriteFolderData = {
      type: 'favorite-folder',
      name: trimmed,
      createdAt: Date.now(),
      byName: app.label || undefined,
    };
    const id = await app.write('event', data);
    setChosen((list) => [...list, id]);
    setName('');
    setError(null);
  };

  const save = async () => {
    const latest = find(targetId);
    if (!latest && chosen.length === 0) {
      sheet.close();
      return;
    }
    const base: FavoriteData = latest?.data ?? {
      type: 'favorite',
      target,
      targetId,
      addedAt: Date.now(),
      byName: app.label || undefined,
    };
    // 保留别的手机上放进去、这里还没同步到的收藏夹的 id：它们不在列表里，用户也没动过。
    const known = new Set(favoriteFolders.map((f) => f.id));
    const kept = (base.folders ?? []).filter((id) => !known.has(id));
    const data: FavoriteData = { ...base, folders: [...kept, ...chosen] };
    const id = latest?.id ?? favoriteIdFor(targetId);
    await app.write('event', data, id);
    sheet.close();
    toast(t().library.foldersSaved, {
      undo: latest ? () => void app.write('event', latest.data, id) : () => void app.remove(id),
    });
  };

  return (
    <>
      <Muted style={{ fontSize: 12, lineHeight: 19 }}>{t().library.folderSheetHint}</Muted>
      {favoriteFolders.length === 0 ? (
        <Muted testID="folder-picker-empty" style={{ fontSize: 13 }}>
          {t().library.noFolders}
        </Muted>
      ) : (
        <View style={s.list}>
          {favoriteFolders.map((folder, i) => {
            const inside = chosen.includes(folder.id);
            return (
              <Pressable
                key={folder.id}
                testID={`folder-pick-${i}`}
                accessibilityRole="checkbox"
                accessibilityLabel={t().library.folderInA11y(folder.data.name, inside)}
                accessibilityState={{ checked: inside }}
                onPress={() =>
                  setChosen((list) =>
                    inside ? list.filter((id) => id !== folder.id) : [...list, folder.id],
                  )
                }
                style={[s.pickRow, i < favoriteFolders.length - 1 ? s.divider : null]}
              >
                <View style={[s.check, inside ? s.checkOn : null]}>
                  {inside ? <Text style={s.checkMark}>✓</Text> : null}
                </View>
                <Text style={s.pickLabel} numberOfLines={1}>
                  {folder.data.name}
                </Text>
                <Text style={[s.pickState, inside ? { color: colors.green } : null]}>
                  {inside ? t().library.inFolder : t().library.notInFolder}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
      <View style={s.newFolder}>
        <View style={{ flex: 1 }}>
          <Field
            testID="folder-new-name"
            label={t().library.newFolderTitle}
            value={name}
            onChangeText={(text) => {
              setName(text);
              if (error) setError(null);
            }}
            placeholder={t().library.folderNamePlaceholder}
            maxLength={40}
            onSubmitEditing={() => void create()}
          />
        </View>
        <Chip
          testID="folder-new-create"
          label={t().library.createFolder}
          selected={false}
          onPress={() => void create()}
          style={{ marginBottom: 6 }}
        />
      </View>
      {error ? (
        <Text testID="folder-error" style={s.error}>
          {error}
        </Text>
      ) : null}
      <Button
        testID="folder-picker-save"
        tone="dark"
        label={t().common.save}
        onPress={() => void save()}
      />
    </>
  );
}

/** 在收藏页直接建一个收藏夹，建好就切过去。 */
export function NewFolderSheet({ onCreated }: { onCreated: (id: string) => void }) {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const { favoriteFolders } = useRecords();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t().library.folderErrors.empty);
      return;
    }
    if (favoriteFolders.some((f) => f.data.name === trimmed)) {
      setError(t().library.folderErrors.duplicate);
      return;
    }
    const id = await app.write('event', {
      type: 'favorite-folder',
      name: trimmed,
      createdAt: Date.now(),
      byName: app.label || undefined,
    });
    sheet.close();
    onCreated(id);
    toast(t().library.folderCreated(trimmed), { undo: () => void app.remove(id) });
  };
  return (
    <>
      <Field
        testID="folder-create-name"
        label={t().library.folderName}
        value={name}
        onChangeText={(text) => {
          setName(text);
          if (error) setError(null);
        }}
        placeholder={t().library.folderNamePlaceholder}
        maxLength={40}
        autoFocus
        onSubmitEditing={() => void create()}
      />
      {error ? (
        <Text testID="folder-error" style={s.error}>
          {error}
        </Text>
      ) : null}
      <Button
        testID="folder-create-save"
        tone="dark"
        label={t().library.createFolder}
        onPress={() => void create()}
      />
    </>
  );
}

/** 收藏夹改名和删除。删除只删收藏夹本身，里面的收藏还在“全部”里。 */
export function FolderEditSheet({
  folder,
  onDeleted,
}: {
  folder: { id: string; data: FavoriteFolderData };
  onDeleted: () => void;
}) {
  const app = useApp();
  const sheet = useSheet();
  const { toast } = useFeedback();
  const { favoriteFolders } = useRecords();
  const confirmDelete = useDeleteConfirm();
  const [name, setName] = useState(folder.data.name);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t().library.folderErrors.empty);
      return;
    }
    if (favoriteFolders.some((f) => f.id !== folder.id && f.data.name === trimmed)) {
      setError(t().library.folderErrors.duplicate);
      return;
    }
    const latest = favoriteFolders.find((f) => f.id === folder.id)?.data ?? folder.data;
    await app.write('event', mergeEdit(folder.data, latest, { name: trimmed }), folder.id);
    sheet.close();
    toast(t().library.folderRenamed, {
      undo: () => void app.write('event', latest, folder.id),
    });
  };

  return (
    <>
      <Field
        testID="folder-rename"
        label={t().library.folderName}
        value={name}
        onChangeText={(text) => {
          setName(text);
          if (error) setError(null);
        }}
        maxLength={40}
      />
      {error ? (
        <Text testID="folder-error" style={s.error}>
          {error}
        </Text>
      ) : null}
      <Button
        testID="folder-rename-save"
        tone="dark"
        label={t().common.save}
        onPress={() => void save()}
      />
      <Button
        testID="folder-delete"
        tone="ghost"
        label={t().library.deleteFolder}
        onPress={() =>
          confirmDelete({ kind: 'favoriteFolder', name: folder.data.name }, async () => {
            const latest = favoriteFolders.find((f) => f.id === folder.id)?.data ?? folder.data;
            await app.remove(folder.id);
            sheet.close();
            onDeleted();
            toast(t().library.folderDeleted, {
              undo: () => void app.write('event', latest, folder.id),
            });
          })
        }
      />
    </>
  );
}

const s = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  paste: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  pasteLabel: { fontSize: 12, color: colors.accent },
  error: { fontSize: 13, color: colors.danger },
  list: {
    backgroundColor: colors.card,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
  },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.rule },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: colors.off,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: colors.green, borderColor: colors.green },
  checkMark: { color: colors.white, fontSize: 12, fontWeight: '700' },
  pickLabel: { flex: 1, fontSize: 14, color: colors.ink },
  pickState: { fontSize: 12, color: colors.muted },
  newFolder: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
});
