import { regionList } from '@xiaodouya/shared';
import { StyleSheet, View } from 'react-native';
import { Chip } from './primitives';

/** 按注册表渲染，新增国家时这里不用改。 */
export function RegionPicker({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (id: string) => void;
}) {
  return (
    <View style={s.row}>
      {regionList.map((region) => (
        <Chip
          key={region.id}
          testID={`region-${region.id}`}
          label={region.name}
          selected={value === region.id}
          onPress={() => onChange(region.id)}
        />
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
